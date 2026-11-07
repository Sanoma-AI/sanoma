import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  allowInsecureRequests,
  authorizationCodeGrantRequest,
  type AuthorizationServer,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  ClientSecretPost,
  generateRandomCodeVerifier,
  generateRandomState,
  nopkce,
  processAuthorizationCodeResponse,
  processRefreshTokenResponse,
  refreshTokenGrantRequest,
  ResponseBodyError,
  skipStateCheck,
  validateAuthResponse,
} from "oauth4webapi";
import { z } from "zod";
import {
  AuthenticationError,
  type AuthenticationProblem,
  defineAuthentication,
  type OAuthFlow,
  type OAuthGrant,
} from "./authentication.ts";
import type { ConnectionTarget } from "./connection.ts";
import type { Db } from "./db.ts";
import { connectionAttempts } from "./db/company.ts";
import { sealAttempt, openAttempt } from "./seal.ts";
import { isLoopback } from "./shared.ts";

// OAuth consent for a named connection whose method is `oauth2`: an attempt, from Connect to the
// exchange. The app's trusted server starts it once `sanoma.connection.authorize` admits it
// (`start`: the state, its hash kept, and the PKCE verifier, sealed), takes the provider's
// callback (`receive`: the state checked against the person's attempt, the code sealed), and the
// worker's `sanoma.connection.exchange` takes the code once (`take`) and posts it to the token
// endpoint (`requestGrant`). None of it enters workflow history: the `connect` run is given the
// attempt's id alone. A stored grant is renewed with its refresh token (`refreshGrant`), under the
// connection's lease (`renewal.ts`). The protocol is oauth4webapi's (panva), which runs on Node and
// workerd alike.

/** The company's OAuth application, stored as a connection's `client` secret: never in a grant. */
export const oauthClient = z.object({
  clientId: z.string().min(1).describe("The OAuth application's client ID"),
  clientSecret: z.string().min(1).describe("The OAuth application's client secret"),
});
export type OAuthClient = z.output<typeof oauthClient>;

/** How the `client` secret's bundle is encoded: one versioned value, as any method's credentials. */
export const oauthApplication = defineAuthentication({
  kind: "fields",
  version: 1,
  schema: oauthClient,
  storage: { writable: false, maxBytes: 8192, conditionalWrites: false },
});

/** How long a person has to consent, and then the worker to take the code: ten minutes each. */
const ATTEMPT_MS = 10 * 60_000;
/** How long an ended or abandoned attempt's row stays for its status, after it expired. */
const KEPT_MS = 60 * 60_000;

/**
 * How an attempt ended: `exchanged` (the grant is stored, the connection pending its
 * activation), `declined` (the person or the provider refused consent), or the problem the
 * exchange met. Null while it is open.
 */
export type AttemptOutcome = "exchanged" | "declined" | AuthenticationProblem;

/** An attempt's progress, for the page that polls it. Never a code, state or token. */
export interface AttemptStatus {
  state: "waiting" | "exchanging" | "connected" | "failed";
  connection: string;
  problem?: Exclude<AttemptOutcome, "exchanged"> | "approval_pending";
  /** The `connect` run, once the callback started it. */
  runId?: string;
}

/** An attempt's row: sealed values among it, never returned past the trusted server. */
type Attempt = typeof connectionAttempts.$inferSelect;

/** What the exchange takes from an attempt, once: opened only inside the operation's driver. */
interface TakenAttempt {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}

/** Why the callback was refused, as the connector page says it: never the provider's words. */
export class CallbackError extends Error {
  readonly reason: "expired" | "mismatch" | "replayed" | "declined" | "rejected";
  constructor(reason: CallbackError["reason"]) {
    super(`OAuth callback: ${reason}`);
    this.name = "CallbackError";
    this.reason = reason;
  }
}

/** The `connect` run of an attempt: one per attempt, so a second callback never starts another. */
export const connectRunId = (attempt: string) => `connect:${attempt}`;

const hash = (state: string) => createHash("sha256").update(state).digest();

/** The provider as oauth4webapi takes it: its endpoints, and the issuer a callback may name (its origin unless declared). */
const serverOf = (flow: OAuthFlow): AuthorizationServer => ({
  issuer: flow.issuer ?? new URL(flow.authorizeUrl).origin,
  authorization_endpoint: flow.authorizeUrl,
  token_endpoint: flow.tokenUrl,
});

/** The attempts of one company's database: rows of `sanoma_connection_attempts`. */
export class ConnectionAttempts {
  private readonly db: () => Promise<Db>;
  constructor(db: () => Promise<Db>) {
    this.db = db;
  }

  /**
   * A new attempt for `principal` on the connection `setup` names, after the authorize gate
   * admitted it: the consent URL to open (its state and challenge in it), and the attempt's id,
   * which the app binds to the person's browser. Sweeps expired attempts first.
   */
  async start(options: {
    flow: OAuthFlow;
    connectionId: string;
    target: ConnectionTarget;
    requestId: string;
    principal: string;
    clientId: string;
    redirectUri: string;
  }): Promise<{ attempt: string; url: string; expiresAt: number }> {
    const { flow } = options;
    await this.sweep();
    const id = randomUUID();
    const state = generateRandomState();
    const verifier = generateRandomCodeVerifier();
    const expiresAt = Date.now() + ATTEMPT_MS;
    await (await this.db()).insert(connectionAttempts).values({
      id,
      connectionId: options.connectionId,
      target: options.target,
      requestId: options.requestId,
      principal: options.principal,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      stateHash: hash(state).toString("base64url"),
      verifier: sealAttempt(id, "verifier", verifier),
      expiresAt: new Date(expiresAt),
    });
    const url = new URL(flow.authorizeUrl);
    url.searchParams.set("client_id", options.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (flow.scopes.length) url.searchParams.set("scope", flow.scopes.join(" "));
    if (flow.pkce) {
      url.searchParams.set("code_challenge", await calculatePKCECodeChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return { attempt: id, url: url.href, expiresAt };
  }

  /**
   * The provider's callback for the person's attempt `id`: refused unless its `state` is the
   * attempt's, it is `principal`'s, open and unexpired, and `flowOf` (the route's check of its
   * connection and redirect URI) gives its flow (`CallbackError`). An error the provider sends
   * ends it; a code is sealed into it, once, and the attempt's metadata returned.
   */
  async receive(
    id: string,
    principal: string,
    params: URLSearchParams,
    flowOf: (row: Attempt) => Promise<OAuthFlow | undefined>,
  ): Promise<Attempt> {
    const db = await this.db();
    const [row] = await db.select().from(connectionAttempts).where(eq(connectionAttempts.id, id));
    const state = params.get("state");
    if (!row || row.principal !== principal || !state) throw new CallbackError("mismatch");
    const expected = Buffer.from(row.stateHash, "base64url");
    const given = hash(state);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new CallbackError("mismatch");
    if (row.code !== null || row.consumedAt !== null || row.outcome !== null) throw new CallbackError("replayed");
    if (row.expiresAt.getTime() <= Date.now()) throw new CallbackError("expired");
    const flow = await flowOf(row);
    if (!flow) throw new CallbackError("mismatch");
    let code: string | null = null;
    try {
      code = validateAuthResponse(serverOf(flow), { client_id: row.clientId }, params, state).get("code");
    } catch {
      // The provider's error (consent declined, say), or a response of another flow: below.
    }
    if (!code) {
      const declined = params.get("error") === "access_denied";
      await this.settle(id, principal, declined ? "declined" : "rejected");
      throw new CallbackError(declined ? "declined" : "rejected");
    }
    const [received] = await db
      .update(connectionAttempts)
      .set({
        code: sealAttempt(id, "code", code),
        receivedAt: sql`now()`,
        expiresAt: new Date(Date.now() + ATTEMPT_MS),
      })
      .where(
        and(
          eq(connectionAttempts.id, id),
          isNull(connectionAttempts.code),
          isNull(connectionAttempts.consumedAt),
          isNull(connectionAttempts.outcome),
        ),
      )
      .returning({ id: connectionAttempts.id });
    if (!received) throw new CallbackError("replayed");
    return row;
  }

  /**
   * The attempt's code and verifier, for the exchange, once: cleared in the same transaction, so
   * a second take (a replay, a retried step) finds it consumed and is `uncertain`, never the code
   * again. Refused for another person or connection (`rejected`), an attempt with no code, past
   * its time or already swept (`expired`): an exchange held for an approval longer than the
   * code's ten minutes ends there, as the provider's code would have expired too.
   */
  async take(id: string, principal: string, connectionId: string): Promise<TakenAttempt> {
    return (await this.db()).transaction(async (tx) => {
      const [row] = await tx.select().from(connectionAttempts).where(eq(connectionAttempts.id, id)).for("update");
      if (!row) throw new AuthenticationError("expired");
      if (row.principal !== principal || row.connectionId !== connectionId) throw new AuthenticationError("rejected");
      if (row.consumedAt !== null) throw new AuthenticationError("uncertain");
      if (row.code === null || row.verifier === null || row.expiresAt.getTime() <= Date.now())
        throw new AuthenticationError("expired");
      await tx
        .update(connectionAttempts)
        .set({ consumedAt: sql`now()`, code: null, verifier: null })
        .where(eq(connectionAttempts.id, id));
      const code = openAttempt(id, "code", row.code);
      const verifier = openAttempt(id, "verifier", row.verifier);
      if (code === undefined || verifier === undefined) throw new AuthenticationError("rejected");
      return { code, verifier, clientId: row.clientId, redirectUri: row.redirectUri };
    });
  }

  /** Records how `principal`'s attempt ended, once: another person's is never theirs to end. */
  async settle(id: string, principal: string, outcome: AttemptOutcome): Promise<void> {
    await (
      await this.db()
    )
      .update(connectionAttempts)
      .set({ outcome, code: null, verifier: null })
      .where(
        and(
          eq(connectionAttempts.id, id),
          eq(connectionAttempts.principal, principal),
          isNull(connectionAttempts.outcome),
        ),
      );
  }

  /** The person's attempt as its row says it, for `SanomaClient.connectionAttempt`; undefined for none of theirs. */
  async get(id: string, principal: string) {
    const [row] = await (
      await this.db()
    )
      .select({
        connectionId: connectionAttempts.connectionId,
        outcome: connectionAttempts.outcome,
        received: sql<boolean>`${connectionAttempts.receivedAt} is not null`,
        expiresAt: connectionAttempts.expiresAt,
      })
      .from(connectionAttempts)
      .where(and(eq(connectionAttempts.id, id), eq(connectionAttempts.principal, principal)));
    return row;
  }

  /** Deletes attempts that expired a while ago, their sealed material with them. */
  async sweep(): Promise<void> {
    await (
      await this.db()
    )
      .delete(connectionAttempts)
      .where(lt(connectionAttempts.expiresAt, new Date(Date.now() - KEPT_MS)));
  }
}

/**
 * The code exchanged at the provider's token endpoint for a grant. A refusal there (a wrong
 * verifier, a used or expired code, a wrong client) is `rejected`; anything else after the
 * request may have reached the provider is `uncertain`, since a code works once.
 */
export async function requestGrant(flow: OAuthFlow, client: OAuthClient, taken: TakenAttempt): Promise<OAuthGrant> {
  const { server, app, authentication, options } = tokenEndpoint(flow, client);
  try {
    // The state was checked at the callback; here the code is put back in oauth4webapi's shape.
    const params = validateAuthResponse(server, app, new URLSearchParams({ code: taken.code }), skipStateCheck);
    const response = await authorizationCodeGrantRequest(
      server,
      app,
      authentication,
      params,
      taken.redirectUri,
      flow.pkce ? taken.verifier : nopkce,
      options,
    );
    return grantOf(await processAuthorizationCodeResponse(server, app, response));
  } catch (error) {
    throw new AuthenticationError(error instanceof ResponseBodyError ? "rejected" : "uncertain");
  }
}

/** The provider's token endpoint as oauth4webapi takes it, with the application's authentication. */
function tokenEndpoint(flow: OAuthFlow, client: OAuthClient) {
  return {
    server: serverOf(flow),
    app: { client_id: client.clientId },
    authentication:
      flow.clientAuthentication === "client_secret_basic"
        ? ClientSecretBasic(client.clientSecret)
        : ClientSecretPost(client.clientSecret),
    options: {
      signal: AbortSignal.timeout(30_000),
      [allowInsecureRequests]: isLoopback(new URL(flow.tokenUrl).hostname),
    },
  };
}

/** A token endpoint's answer as a grant, `previous`'s refresh token and scopes kept where the answer leaves them out (RFC 6749 section 6). */
function grantOf(
  token: { access_token: string; token_type: string; refresh_token?: string; expires_in?: number; scope?: string },
  previous?: OAuthGrant,
): OAuthGrant {
  const refreshToken = token.refresh_token ?? previous?.refreshToken;
  const scopes = token.scope !== undefined ? token.scope.split(/[\s,]+/).filter(Boolean) : previous?.scopes;
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    ...(refreshToken && { refreshToken }),
    ...(token.expires_in !== undefined && { expiresAt: Date.now() + token.expires_in * 1000 }),
    ...(scopes !== undefined && { scopes }),
  };
}

/**
 * The grant renewed at the provider's token endpoint with its refresh token. A refusal (any 4xx
 * answer) issued nothing: `unavailable` for 429 (ask later), `revoked` for `invalid_grant` (the refresh token no longer works, so
 * only Reconnect helps), `rejected` for any other. Anything else once the request may have reached
 * the provider (no answer, a 5xx, an answer that does not read as a grant) is `uncertain`: a
 * provider that rotates refresh tokens may have spent this one, so it is never sent again.
 */
export async function refreshGrant(flow: OAuthFlow, client: OAuthClient, grant: OAuthGrant): Promise<OAuthGrant> {
  if (!grant.refreshToken) throw new AuthenticationError("expired");
  const { server, app, authentication, options } = tokenEndpoint(flow, client);
  let response: Response;
  try {
    response = await refreshTokenGrantRequest(server, app, authentication, grant.refreshToken, options);
  } catch {
    throw new AuthenticationError("uncertain");
  }
  try {
    return grantOf(await processRefreshTokenResponse(server, app, response), grant);
  } catch (error) {
    // Too many requests: refused, nothing issued, and worth asking again later.
    if (response.status === 429) throw new AuthenticationError("unavailable");
    // Any other 4xx refused the refresh token, nothing issued: `invalid_grant` says it no longer counts.
    if (response.status >= 400 && response.status < 500)
      throw new AuthenticationError(
        error instanceof ResponseBodyError && error.error === "invalid_grant" ? "revoked" : "rejected",
      );
    // A 2xx the library refused, or a server error: whether a grant was issued is not known.
    throw new AuthenticationError("uncertain");
  }
}
