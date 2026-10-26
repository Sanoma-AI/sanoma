import { resolveConfig, type SanomaConfig } from "./config.ts";
import { shouldWake } from "./db.ts";
import type { SelfStop } from "./deadlines.ts";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";
import { startWorker, type Worker, type WorkerOptions } from "./worker.ts";

// One worker at a time in a process that outlives it. A worker that stops itself when idle (a
// wakeup declared) cannot launch again, so the next write that needs one, or the wakeup's wake,
// starts a fresh worker. `sanoma serve` runs its worker through it, and so does the testing
// kit's host in this process.

/** A worker under a supervisor (`superviseWorker`). */
export interface Supervisor {
  /** True from the moment the worker stopped itself until a fresh one starts. */
  readonly stopped: boolean;
  /**
   * Starts a fresh worker when the last one stopped itself, for a write that needs one (a run's
   * start, an approval's decision); a no-op while one starts or runs. Resolves once it runs, or
   * once its failure to start is logged: the next call tries again. Never rejects.
   */
  resume(): Promise<void>;
  /**
   * A wakeup's `GET /wake?generation=N`: `resume` when the worker stopped with `generation`
   * registered (`shouldWake`); a no-op for any other, and while one starts or runs.
   */
  wake(generation: number): Promise<void>;
  /** Stops the worker running or starting, and starts none again. */
  stop(): Promise<void>;
}

export interface SupervisorOptions extends Omit<WorkerOptions, "onStopped"> {
  /**
   * False: the worker never stops itself, as on an app on this machine alone, whose wakeup
   * would wake the instance the host runs. Default true.
   */
  selfStop?: boolean;
  /** Told each time the worker stops itself, once a fresh one is starting for a write it heard, or `stopped` is true. */
  onStopped?: (stopped: SelfStop) => void;
}

/**
 * Starts a worker on `config` that stops itself when idle with a wakeup declared (`onStopped`
 * in `WorkerOptions`), and a fresh one each time `resume` or `wake` asks after it did. Throws
 * when the first does not start. A write heard while a worker runs may land after its last check
 * for being idle, so a worker that stops itself after one is started again at once: it stops
 * again on its own when nothing came of it.
 */
export async function superviseWorker(config: SanomaConfig, options: SupervisorOptions = {}): Promise<Supervisor> {
  const { onStopped, selfStop = true, ...workerOptions } = options;
  let worker: Worker | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  // A write while the worker runs, since it started.
  let heard = false;
  let databaseUrl: string | undefined;

  const launch = async () => {
    heard = false;
    const started = await startWorker(config, { ...workerOptions, ...(selfStop && { onStopped: selfStopped }) });
    if (closed) await started.stop();
    else worker = started;
  };
  const selfStopped = (stopped: SelfStop) => {
    worker = undefined;
    if (closed) return;
    // Resumed first, so `stopped` is false when `onStopped` (the exit rule) looks.
    if (heard) void supervisor.resume();
    onStopped?.(stopped);
  };

  const supervisor: Supervisor = {
    get stopped() {
      return !closed && !worker && !starting;
    },
    resume() {
      if (closed) return Promise.resolve();
      if (worker) {
        heard = true;
        return Promise.resolve();
      }
      return (starting ??= launch()
        .catch((err: unknown) => warn(`the worker could not start again: ${errorMessage(err)}`))
        .finally(() => {
          starting = undefined;
        }));
    },
    async wake(generation) {
      if (!supervisor.stopped) return;
      databaseUrl ??= resolveConfig(config).databaseUrl;
      if (await shouldWake(databaseUrl, generation)) await supervisor.resume();
    },
    async stop() {
      closed = true;
      await starting;
      const running = worker;
      worker = undefined;
      await running?.stop();
    },
  };
  await launch();
  return supervisor;
}
