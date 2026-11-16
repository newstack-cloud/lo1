import { resolve } from "node:path";
import type { RestartSignal } from "@lo1/sdk";
import { createLog } from "../debug";
import { restartService, type RestartContext } from "./restart";
import type { ServiceHandle } from "./service";

const debug = createLog("orchestrator:watch");

export type WatchHandle = { stop: () => void };

/**
 * Follows each plugin's watchForChanges() for the services it owns and
 * restarts a service whenever its plugin yields a restart signal. Restarted
 * handles replace the old ones in `handles`, so teardown stops the new ones.
 * Restarts of one service never overlap; a failed restart is reported and
 * watching continues.
 */
export function watchPluginServices(handles: ServiceHandle[], ctx: RestartContext): WatchHandle {
  const iterators: AsyncIterator<RestartSignal>[] = [];
  let stopped = false;

  for (const [name, service] of Object.entries(ctx.config.services)) {
    const plugin = ctx.plugins.get(service.type);
    if (service.mode === "skip" || service.initTask || !plugin?.watchForChanges) continue;

    const iterable = plugin.watchForChanges({
      serviceName: name,
      servicePath: resolve(ctx.workspaceDir, service.path),
    });
    const iterator = iterable[Symbol.asyncIterator]();
    iterators.push(iterator);
    void followSignals(name, iterator);
  }

  async function followSignals(name: string, iterator: AsyncIterator<RestartSignal>) {
    debug("watching %s", name);
    while (!stopped) {
      const next = await iterator.next().catch((err: unknown) => {
        ctx.emit({ kind: "error", message: `Watching "${name}" failed: ${String(err)}` });
        return { done: true as const, value: undefined };
      });
      if (next.done || stopped) return;

      ctx.emit({ kind: "phase", phase: `Restarting ${name}: ${next.value.reason}` });
      await restartAndReplace(name);
    }
  }

  async function restartAndReplace(name: string) {
    const index = handles.findIndex((h) => h.serviceName === name);
    try {
      const handle = await restartService(name, handles[index], ctx);
      if (index === -1) handles.push(handle);
      else handles[index] = handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({ kind: "error", message: `Restarting "${name}" failed: ${message}` });
    }
  }

  return {
    stop: () => {
      stopped = true;
      for (const iterator of iterators) void iterator.return?.();
    },
  };
}
