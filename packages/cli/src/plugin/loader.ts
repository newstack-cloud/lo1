import { resolve } from "node:path";
import type { Plugin, PluginContext, PluginFactory } from "@lo1/sdk";
import { createLog } from "../debug";
import { Lo1Error } from "../errors";

const debug = createLog("plugin");

export class PluginError extends Lo1Error {
  constructor(
    message: string,
    public readonly pluginName?: string,
  ) {
    super(message, "PluginError", pluginName ? { plugin: pluginName } : undefined);
    this.name = "PluginError";
  }
}

export type ImportFn = (specifier: string) => Promise<{ default?: unknown }>;

const defaultImport: ImportFn = (specifier) => import(specifier);

export function resolveSpecifier(specifier: string, workspaceDir: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolve(workspaceDir, specifier);
  }
  return specifier;
}

export async function loadPlugin(
  specifier: string,
  context: PluginContext,
  importFn: ImportFn = defaultImport,
): Promise<Plugin> {
  const resolved = resolveSpecifier(specifier, context.workspaceDir);
  debug("loadPlugin: specifier=%s resolved=%s", specifier, resolved);

  let mod: { default?: unknown };
  try {
    mod = await importFn(resolved);
  } catch (err) {
    throw new PluginError(
      `Failed to import plugin "${specifier}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (mod.default === undefined || mod.default === null) {
    throw new PluginError(`Plugin "${specifier}" has no default export`);
  }

  if (typeof mod.default !== "function") {
    throw new PluginError(
      `Plugin "${specifier}" default export is not a function (got ${typeof mod.default})`,
    );
  }

  const factory = mod.default as PluginFactory;
  const plugin = await factory(context);

  const methods = [
    plugin.contributeCompose && "contributeCompose",
    plugin.configureContainer && "configureContainer",
    plugin.provisionInfra && "provisionInfra",
    plugin.seedData && "seedData",
  ].filter(Boolean);
  debug("loadPlugin: name=%s methods=%o", plugin.name, methods);

  if (!plugin.name) {
    throw new PluginError(`Plugin "${specifier}" factory returned a plugin with no name`);
  }

  return plugin;
}

export async function loadPlugins(
  declarations: Record<string, string>,
  context: PluginContext,
  importFn: ImportFn = defaultImport,
): Promise<Map<string, Plugin>> {
  debug("loadPlugins: %d declared", Object.keys(declarations).length);
  const plugins = new Map<string, Plugin>();

  for (const [key, specifier] of Object.entries(declarations)) {
    const plugin = await loadPlugin(specifier, context, importFn);

    if (plugin.name !== key) {
      throw new PluginError(
        `Plugin "${specifier}" returned name "${plugin.name}" but was declared as "${key}"`,
        plugin.name,
      );
    }

    plugins.set(key, plugin);
  }

  return plugins;
}
