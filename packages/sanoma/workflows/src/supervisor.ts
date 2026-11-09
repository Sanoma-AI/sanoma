import type { SanomaConfig } from "./config.ts";
import type { SelfStop } from "./deadlines.ts";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";
import { startWorker, type Worker, type WorkerOptions, type WorkerStop } from "./worker.ts";

// One worker at a time in a process that outlives it. A worker that stops itself when idle (a
// wakeup declared) cannot launch again, so the next write that needs one, or the wakeup's wake,
// starts a fresh worker. `sanoma serve` and `sanoma worker` run their worker through it, and so
// does the testing kit's host in this process.

/** A worker under a supervisor (`superviseWorker`). */
export interface Supervisor {
  /** True from the moment the worker stopped itself, or a fresh one failed to start, until a fresh one starts. */
  readonly stopped: boolean;
  /**
   * Asks for a worker that looks at the database after this moment: for a write that needs one
   * (a run's start, an approval's decision, asked once it committed) or a wakeup's `GET /wake`,
   * in whatever order the two come. With the last worker stopped, a fresh one starts. While one
   * starts or runs, it is heard: once that one stops itself (its checks may have run before the
   * write committed), a fresh one starts, whose checks all come after this call, and stops again
   * on its own when nothing came of it. Resolves once a worker runs, or once its failure to start
   * is logged and told (`onEnded`): the next call tries again. Never rejects.
   */
  wake(): Promise<void>;
  /** Stops the worker running or starting, and starts none again; `register` as `Worker.stop` takes it. */
  stop(options?: WorkerStop): Promise<void>;
}

export interface SupervisorOptions extends Omit<WorkerOptions, "onStopped"> {
  /**
   * False: the worker never stops itself, as on an app on this machine alone, whose wakeup
   * would wake the instance the host runs. Default true.
   */
  selfStop?: boolean;
  /** Told each time the worker stops itself, once a fresh one is starting for a wake it heard, or `stopped` is true. */
  onStopped?: (stopped: SelfStop) => void;
  /**
   * Told each time the supervisor is left with no worker and none starting: the worker stopped
   * itself and heard no wake, or a fresh one failed to start (`failure`, why). Not after `stop`.
   */
  onEnded?: (failure?: { error: unknown }) => void;
}

/**
 * Starts a worker on `config` that stops itself when idle with a wakeup declared (`onStopped`
 * in `WorkerOptions`), and a fresh one each time `wake` asks after it did, or asked while it ran.
 * Throws when the first does not start.
 */
export async function superviseWorker(config: SanomaConfig, options: SupervisorOptions = {}): Promise<Supervisor> {
  const { onStopped, onEnded, selfStop = true, ...workerOptions } = options;
  let worker: Worker | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  // A wake while the worker starts or runs, since it began starting.
  let heard = false;

  const launch = async () => {
    heard = false;
    const started = await startWorker(config, { ...workerOptions, ...(selfStop && { onStopped: selfStopped }) });
    if (closed) await started.stop();
    else worker = started;
  };
  const selfStopped = (stopped: SelfStop) => {
    worker = undefined;
    if (closed) return;
    // Read before the wake, whose launch clears it.
    const again = heard;
    // Woken first, so `stopped` is false when `onStopped` looks.
    if (again) void supervisor.wake();
    onStopped?.(stopped);
    if (!again) onEnded?.();
  };

  const supervisor: Supervisor = {
    get stopped() {
      return !closed && !worker && !starting;
    },
    wake() {
      if (closed) return Promise.resolve();
      if (worker || starting) {
        heard = true;
        return starting ?? Promise.resolve();
      }
      return (starting = launch().then(
        () => void (starting = undefined),
        (error: unknown) => {
          starting = undefined;
          warn(`the worker could not start again: ${errorMessage(error)}`);
          if (!closed) onEnded?.({ error });
        },
      ));
    },
    async stop(how) {
      closed = true;
      await starting;
      const running = worker;
      worker = undefined;
      await running?.stop(how);
    },
  };
  await launch();
  return supervisor;
}
