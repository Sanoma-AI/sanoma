import type { Principal } from "@sanoma/workflows";
import { ACTOR_HEADER } from "./api.ts";

/** The default `resolveActor`: the URI-encoded name in the `x-sanoma-actor` header, as `{ id }`. */
export function actorFromHeader(request: Request): Principal | undefined {
  let id = request.headers.get(ACTOR_HEADER) ?? "";
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not URI-encoded: take it as sent.
  }
  id = id.trim();
  return id ? { id } : undefined;
}
