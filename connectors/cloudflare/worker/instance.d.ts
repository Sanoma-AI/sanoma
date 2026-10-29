// The types of `instance.js`, for the package's TypeScript: the fake runs it, and `src/` names its routes.

/** The object's own route: the wake it holds. */
export declare const WAKE_PATH: "/__sanoma/wake";
/** The object's route that answers `{ revision, running }`; with `?start=1`, once the container answers `/healthz`. */
export declare const HEALTH_PATH: "/__sanoma/health";
/** How long the container keeps running after the last request: Cloudflare stops it then. */
export declare const INACTIVITY_MS: number;
/** The binding that names the object, in the Worker's env. */
export declare const NAMESPACE: "SANOMA_INSTANCE";
/** The name the upload gives the runtime image (`containers[].images`), which the object starts. */
export declare const IMAGE: "runtime";

/** The label naming an image: a digest of it. */
export declare function imageLabel(image: string): Promise<string>;

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
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** One object of the Worker. */
export declare class Instance {
  constructor(ctx: ObjectState, env: Record<string, unknown>);
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

/** The Worker's default export: every request goes to the one object. */
export declare const worker: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
