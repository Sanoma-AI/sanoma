import { createContext, useContext, useSyncExternalStore } from "react";
import type { ActorInfo } from "./api.ts";

// Who you are. With the default resolver there is no login: the page asks once, keeps the name
// in this browser, and sends it with every change; that name is read only in the browser, and
// the server render knows no one. A deployment with its own `resolveActor` says who you are
// itself, and the page shows that instead.

const ACTOR_KEY = "sanoma.actor";

/** The name this page last saved, which outlasts storage that is blocked until the page reloads. */
let saved: string | null | undefined;
/** The roots reading the name, told when it changes. */
const readers = new Set<() => void>();

export function loadActor(): string | null {
  if (saved !== undefined) return saved;
  try {
    return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function saveActor(name: string | null) {
  saved = name;
  try {
    if (name) localStorage.setItem(ACTOR_KEY, name);
    else localStorage.removeItem(ACTOR_KEY);
  } catch {
    // Storage blocked: `saved` keeps the name.
  }
  for (const read of readers) read();
}

/** Calls `onChange` when the name changes, here or in another tab. */
function watchActor(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ACTOR_KEY && event.key !== null) return;
    // Another tab saved it: storage has the name now.
    saved = undefined;
    onChange();
  };
  readers.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    readers.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The server, and the browser while it hydrates, have read no name: undefined. */
const notRead = () => undefined;

export interface ActorState {
  /** The name, or null for none; undefined only until the page has read the browser's storage. */
  actor: string | null | undefined;
  /** The groups the deployment vouches for. None with the default resolver: a typed name has none. */
  groups: readonly string[];
  /** True when the deployment says who you are: the page shows it and cannot change it. */
  fromServer: boolean;
  /** Set when the deployment could not say who you are. */
  error?: string;
  setActor(name: string | null): void;
}

export const ActorContext = createContext<ActorState>({
  actor: undefined,
  groups: [],
  fromServer: false,
  setActor: () => {},
});

export const useActor = () => useContext(ActorContext);

/**
 * The actor state for the root. With a deployment's own resolver, who the server says; else the
 * name in this browser's storage, read once hydrated so hydration matches the server.
 */
export function useActorState(server: ActorInfo): ActorState {
  const stored = useSyncExternalStore(watchActor, loadActor, notRead);
  if (server.fromServer) {
    const { actor, error } = server;
    return {
      actor: actor?.id ?? null,
      groups: actor?.groups ?? [],
      fromServer: true,
      ...(error === undefined ? {} : { error }),
      setActor() {},
    };
  }
  return {
    actor: stored,
    groups: [],
    fromServer: false,
    setActor: saveActor,
  };
}
