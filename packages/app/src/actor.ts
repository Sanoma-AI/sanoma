import { createContext, useContext, useEffect, useState } from "react";

// Who you are. There is no login: the page asks once, keeps the name in this browser, and
// sends it with every change. Read only in the browser; the server render knows no one.

const ACTOR_KEY = "sanoma.actor";

export function loadActor(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function saveActor(name: string | null) {
  try {
    if (name) localStorage.setItem(ACTOR_KEY, name);
    else localStorage.removeItem(ACTOR_KEY);
  } catch {
    // Storage blocked: the name lasts until the page reloads.
  }
}

export interface ActorState {
  /** The name, or null for none; undefined only until the page has read the browser's storage. */
  actor: string | null | undefined;
  setActor(name: string | null): void;
}

export const ActorContext = createContext<ActorState>({ actor: undefined, setActor: () => {} });

export const useActor = () => useContext(ActorContext);

/** The actor state for the root: read from storage after the first render, so hydration matches the server. */
export function useActorState(): ActorState {
  const [actor, setState] = useState<string | null>();
  useEffect(() => setState(loadActor()), []);
  return {
    actor,
    setActor(name) {
      saveActor(name);
      setState(name);
    },
  };
}
