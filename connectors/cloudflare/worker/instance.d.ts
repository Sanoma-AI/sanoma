// The types of `instance.js`, for the package's TypeScript: the fake runs it, and `src/` names its routes.
import type { AppBundleModule } from "@sanoma-ai/app";

/** The object's route that holds the company's wake, with the instance token. */
export declare const WAKE_PATH: "/__sanoma/wake";
/** The object's route that answers what the Worker runs; with `?start=1` and the instance token, it starts the container at it. */
export declare const HEALTH_PATH: "/__sanoma/health";
/** The worker port's route of the app bundle at `?revision=`, which the object passes on with the instance token. */
export declare const APP_BUNDLE_PATH: "/__sanoma/app-bundle";
/** The header on every answer of the object: the deployment of the Worker version that answered (`deploymentOf`). */
export declare const DEPLOYMENT_HEADER: "x-sanoma-deployment";
/** The header the app reads the visitor's address from. */
export declare const CLIENT_IP_HEADER: "x-sanoma-client-ip";
/** How long the container keeps running after the object's last request: Cloudflare stops it then. */
export declare const INACTIVITY_MS: number;
/** The Worker version's metadata binding (`version_metadata`): its `tag`, the revision of the app it serves. */
export declare const VERSION_METADATA: "CF_VERSION_METADATA";
/** The binding that names the object, in the Worker's env. */
export declare const NAMESPACE: "SANOMA_INSTANCE";
/** The name the upload gives the runtime image (`containers[].images`), which the object starts. */
export declare const IMAGE: "runtime";

/** A label of a value too long for one: a digest of it. */
export declare function digestLabel(value: string): Promise<string>;

/** What a Worker version deploys, as one label: its revision, configuration revision, declared image and the revision of the app it serves. */
export declare function deploymentOf(
  revision: string | undefined,
  configurationRevision: string | null | undefined,
  image: string | undefined,
  app: string | undefined,
): Promise<string>;

/** What the object's code needs of a Durable Object's `ctx`: its container and its storage. */
export interface ObjectState {
  container: {
    readonly running: boolean;
    /** The images the Worker's upload names (`containers[].images`), by name. */
    readonly images: Record<string, string>;
    start(options: {
      image: string;
      instance: string;
      env: Record<string, string>;
      enableInternet: boolean;
      labels: Record<string, string>;
    }): void;
    inspect(): Promise<{ image?: string; labels: Record<string, string> } | null>;
    /** Sends the container's process a POSIX signal: 15, SIGTERM, drains the worker. */
    signal(signal: number): void;
    destroy(reason?: string): Promise<void>;
    getTcpPort(port: number): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
    setInactivityTimeout(ms: number): Promise<void>;
    /** Settles when the container started last ends: resolved on exit 0, rejected on any other. */
    monitor?(): Promise<void>;
  };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** One object of the Worker. */
export declare class Instance {
  constructor(ctx: ObjectState, env: Record<string, unknown>);
  /** Its routes: the wake, the health (with `?start=1`, a start), the app bundle; each answer with `DEPLOYMENT_HEADER`. */
  fetch(request: Request): Promise<Response>;
  /** `info` as Cloudflare gives it: how many times this alarm was retried. */
  alarm(info?: { retryCount: number; isRetry: boolean }): Promise<void>;
  /** Starts the container from an alarm now, without waiting for it. */
  startNow(): Promise<void>;
}

/** What the Worker's request gives its handlers to keep working after the response. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The Worker script's fetch: the object's routes, the Host contract's `/wake`, and the app bundle (`loadApp`) for the rest. */
export declare function serve(
  request: Request,
  env: Record<string, unknown>,
  ctx: WorkerContext,
  loadApp: () => Promise<{ default: AppBundleModule }>,
): Promise<Response>;
