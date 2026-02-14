import { describe, it, expect, mock } from "bun:test";
import {
  resolveSpecifier,
  loadPlugin,
  loadPlugins,
  PluginError,
  type ImportFn,
} from "../../src/plugin/loader";
import type { Plugin, PluginContext } from "@lo1/sdk";

const context: PluginContext = {
  workspaceDir: "/workspace",
  workspaceName: "test-project",
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
};

const makePlugin = (name: string): Plugin => ({ name });

const makeImportFn = (factory: unknown): ImportFn =>
  mock<ImportFn>(() => Promise.resolve({ default: factory }));

describe("resolveSpecifier", () => {
  it("should resolve relative path with workspaceDir", () => {
    const result = resolveSpecifier("./plugins/custom", "/workspace");

    expect(result).toBe("/workspace/plugins/custom");
  });

  it("should resolve dot-dot relative path with workspaceDir", () => {
    const result = resolveSpecifier("../shared/plugin", "/workspace/project");

    expect(result).toBe("/workspace/shared/plugin");
  });

  it("should pass npm package specifiers through unchanged", () => {
    expect(resolveSpecifier("@lo1/plugin-celerity", "/workspace")).toBe("@lo1/plugin-celerity");
  });

  it("should resolve absolute paths unchanged", () => {
    expect(resolveSpecifier("/absolute/path/plugin", "/workspace")).toBe("/absolute/path/plugin");
  });
});

describe("loadPlugin", () => {
  it("should call factory with correct PluginContext", async () => {
    const factory = mock(() => makePlugin("test"));
    const importFn = makeImportFn(factory);

    await loadPlugin("@lo1/test-plugin", context, importFn);

    expect(factory).toHaveBeenCalledWith(context);
  });

  it("should return Plugin from factory", async () => {
    const plugin = makePlugin("test");
    const importFn = makeImportFn(() => plugin);

    const result = await loadPlugin("@lo1/test-plugin", context, importFn);

    expect(result).toBe(plugin);
  });

  it("should throw PluginError on import failure", () => {
    const importFn = mock<ImportFn>(() => Promise.reject(new Error("module not found")));

    expect(loadPlugin("@lo1/missing", context, importFn)).rejects.toThrow(PluginError);
    expect(loadPlugin("@lo1/missing", context, importFn)).rejects.toThrow(/Failed to import/);
  });

  it("should throw PluginError when no default export", () => {
    const importFn = mock<ImportFn>(() => Promise.resolve({ default: undefined }));

    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(PluginError);
    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(/no default export/);
  });

  it("should throw PluginError when default export is not a function", () => {
    const importFn = mock<ImportFn>(() => Promise.resolve({ default: "not-a-function" }));

    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(PluginError);
    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(/not a function/);
  });

  it("should throw PluginError when factory returns no name", () => {
    const importFn = makeImportFn(() => ({ name: "" }));

    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(PluginError);
    expect(loadPlugin("@lo1/bad", context, importFn)).rejects.toThrow(/no name/);
  });
});

describe("loadPlugins", () => {
  it("should load multiple plugins into Map", async () => {
    const importFn = mock<ImportFn>((specifier) => {
      const name = specifier === "@lo1/plugin-a" ? "alpha" : "beta";
      return Promise.resolve({ default: () => makePlugin(name) });
    });

    const result = await loadPlugins(
      { alpha: "@lo1/plugin-a", beta: "@lo1/plugin-b" },
      context,
      importFn,
    );

    expect(result.size).toBe(2);
    expect(result.get("alpha")!.name).toBe("alpha");
    expect(result.get("beta")!.name).toBe("beta");
  });

  it("should throw PluginError on name mismatch", () => {
    const importFn = makeImportFn(() => makePlugin("wrong-name"));

    expect(
      loadPlugins({ expected: "@lo1/plugin" }, context, importFn),
    ).rejects.toThrow(PluginError);
    expect(
      loadPlugins({ expected: "@lo1/plugin" }, context, importFn),
    ).rejects.toThrow(/returned name "wrong-name" but was declared as "expected"/);
  });
});
