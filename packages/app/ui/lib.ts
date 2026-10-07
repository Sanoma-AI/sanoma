import { useCallback, useEffect, useRef, useState } from "react";
import { ACTOR_HEADER, type ErrorResponse } from "../src/api.ts";

// --- Who you are ---------------------------------------------------------------------------------

const ACTOR_KEY = "sanoma.actor";

export function loadActor(): string | undefined {
  try {
    return localStorage.getItem(ACTOR_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveActor(name: string | undefined) {
  try {
    if (name) localStorage.setItem(ACTOR_KEY, name);
    else localStorage.removeItem(ACTOR_KEY);
  } catch {
    // Storage blocked: the name lasts until the page reloads.
  }
  actor = name;
}

let actor = loadActor();

// --- The API ---------------------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly body: Partial<ErrorResponse>;

  constructor(status: number, body: Partial<ErrorResponse>) {
    super(body.error ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Calls the app's API as the current actor. Throws `ApiError` for any non-2xx answer. */
export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // URI-encoded, so a name outside Latin-1 still fits in a header. The server decodes it.
  if (actor) headers[ACTOR_HEADER] = encodeURIComponent(actor);
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status, (body ?? {}) as Partial<ErrorResponse>);
  return body as T;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- Polling ---------------------------------------------------------------------------------------

export interface Polled<T> {
  data?: T;
  error?: string;
  /** Set when the last answer was a 404. */
  missing?: boolean;
  reload(): void;
}

/** Fetches `path` now and every 2 seconds while the page is visible. */
export function usePoll<T>(path: string): Polled<T> {
  const [state, setState] = useState<{ path: string; data?: T; error?: string; missing?: boolean }>({ path });
  // The path being fetched, so a slow answer is not fetched again, and a new path need not wait.
  const inFlight = useRef<string | null>(null);
  const latest = useRef(path);
  latest.current = path;

  const load = useCallback(async () => {
    if (inFlight.current === path || document.visibilityState !== "visible") return;
    inFlight.current = path;
    try {
      const data = await api<T>(path);
      if (latest.current === path) setState({ path, data });
    } catch (err) {
      if (latest.current === path) {
        setState((s) => ({
          path,
          data: s.path === path ? s.data : undefined,
          error: errorText(err),
          missing: err instanceof ApiError && err.status === 404,
        }));
      }
    } finally {
      if (inFlight.current === path) inFlight.current = null;
    }
  }, [path]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const current = state.path === path ? state : { path };
  return { data: current.data, error: current.error, missing: current.missing, reload: () => void load() };
}

// --- Hash routes -----------------------------------------------------------------------------------

export type Route =
  | { page: "runs" }
  | { page: "run"; id: string }
  | { page: "inbox" }
  | { page: "start"; workflow?: string }
  | { page: "workflows" };

export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  switch (parts[0]) {
    case "runs":
      return parts[1] ? { page: "run", id: decodeURIComponent(parts[1]) } : { page: "runs" };
    case "inbox":
      return { page: "inbox" };
    case "start":
      return { page: "start", workflow: params.get("workflow") ?? undefined };
    case "workflows":
      return { page: "workflows" };
    default:
      return { page: "runs" };
  }
}

export const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

// --- Formatting ------------------------------------------------------------------------------------

export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
}

export const fullTime = (ms: number) => new Date(ms).toLocaleString();
