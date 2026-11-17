import { resolve } from "node:path";
import type { RestartSignal } from "@lo1/sdk";
import { createLog } from "../debug";
import { restartService, type RestartContext } from "./restart";
import type { ServiceHandle } from "./service";

const debug = createLog("orchestrator:watch");

export type WatchHandle = {
  /** Stops watching and resolves once any restart already under way has finished. */
  stop: () => Promise<void>;
};

export type WatchOptions = {
  /** Runs each restart exclusively, e.g. under the workspace state lock. */
  runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Called with each replacement handle, inside `runExclusive`, to record it. */
  onReplaced?: (handle: ServiceHandle) => Promise<void>;
  /**
   * The service's handle as the state file records it, read inside
   * `runExclusive`. Lets a restart pick up a process `lo1 restart` started
   * since this watcher last replaced the service.
   */
  recordedHandle?: (name: string) => Promise<ServiceHandle | undefined>;
};

/** Whether two handles refer to different host processes or containers. */
function isDifferentInstance(held: ServiceHandle | undefined, recorded: ServiceHandle): boolean {
  if (recorded.type === "process") return recorded.pid !== held?.pid;
  if (recorded.type === "container") return recorded.containerId !== held?.containerId;
  // Compose services are recreated by compose itself, whichever handle is used.
  return false;
}

/**
 * Follows each plugin's watchForChanges() for the services it owns and
 * restarts a service whenever its plugin yields a restart signal. Restarted
 * handles replace the old ones in `handles`, so teardown stops the new ones.
 * Restarts of one service never overlap; a failed restart is reported and
 * watching continues.
 */
export function watchPluginServices(
  handles: ServiceHandle[],
  ctx: RestartContext,
  options: WatchOptions = {},
): WatchHandle {
  const runExclusive = options.runExclusive ?? ((fn) => fn());
  const iterators: AsyncIterator<RestartSignal>[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  const closeIterators = () => {
    stopped = true;
    for (const iterator of iterators) void iterator.return?.();
  };

  try {
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
  } catch (err) {
    // Don't leave the watchers that did start running behind a failed setup.
    closeIterators();
    throw err;
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
      const restart = runExclusive(() => restartAndReplace(name)).catch((err: unknown) =>
        reportRestartFailure(name, err),
      );
      inFlight.add(restart);
      await restart;
      inFlight.delete(restart);
    }
  }

  /** The handle to restart from: ours, unless `lo1 restart` has replaced the service since. */
  async function currentHandle(name: string, held: ServiceHandle | undefined) {
    const recorded = await options.recordedHandle?.(name);
    if (!recorded || !isDifferentInstance(held, recorded)) return held;
    debug("%s was restarted elsewhere; restarting from the recorded handle", name);
    return recorded;
  }

  async function restartAndReplace(name: string) {
    const index = handles.findIndex((h) => h.serviceName === name);
    try {
      const current = await currentHandle(name, handles[index]);
      const handle = await restartService(name, current, ctx);
      if (index === -1) handles.push(handle);
      else handles[index] = handle;
      await options.onReplaced?.(handle);
    } catch (err) {
      reportRestartFailure(name, err);
    }
  }

  function reportRestartFailure(name: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({ kind: "error", message: `Restarting "${name}" failed: ${message}` });
  }

  return {
    stop: async () => {
      closeIterators();
      await Promise.allSettled([...inFlight]);
    },
  };
}
