// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { SetupProgress } from "../api.ts";
import type { AppContext } from "../context.ts";
import { KEYS } from "./go-live.ts";
import { chatModel } from "./models.ts";

/**
 * Home's setup card, each step from facts: the company is started (it is, to be open); the agent
 * connected (the chat's model ready, or the person has chosen the engine new chats open on,
 * `engine`, from its cookie); a workflow of the company's own has finished a run; more than one
 * person is declared; and it is online (its host bound, or this instance a hosted one).
 */
export async function setupProgress(app: AppContext, engine: string | undefined): Promise<SetupProgress> {
  const { snapshot, client, place } = app;
  const own = snapshot.description.workflows.filter((wf) => !wf.builtin);
  const [model, finished] = await Promise.all([
    engine ? undefined : chatModel(app),
    Promise.all(own.map((wf) => client.runs({ workflow: wf.name, status: "finished", limit: 1 }))),
  ]);
  return {
    start: true,
    agent: Boolean(engine) || model?.ready === true,
    try: finished.some((runs) => runs.length > 0),
    teammate: snapshot.people.people.filter((p) => p.type === "person").length > 1,
    online: snapshot.bound.includes(KEYS.host) || place === "live",
  };
}
