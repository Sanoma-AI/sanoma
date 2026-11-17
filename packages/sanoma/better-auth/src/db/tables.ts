import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  type PgSchema,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Better Auth's tables, as its Drizzle adapter reads them: the properties are its field names,
// the columns their snake_case (`casing`, as the runtime's `databaseOn` and `drizzle/*.config.ts`
// have it), plus the user's `github` (`TABLE_OPTIONS` in `instance.ts`). Each login has the set in
// a schema of its own (`visitors.ts`, `staff.ts`), from which drizzle-kit generates its
// migrations, so a change here is a new migration in both folders: `pnpm --filter
// sanoma generate`. Row-level security is on with no policy, as on the runtime's own tables
// (`sanoma/workflows`' `db/company.ts`).

const when = () => timestamp({ withTimezone: true });

/** Better Auth's tables in the schema `name`, by its model names, as `drizzleAdapter` takes them; `schema` is the schema itself. */
export function loginTables<Name extends string>(name: Name) {
  const schema = pgSchema(name);
  const user = schema
    .table("user", {
      id: text().primaryKey(),
      name: text().notNull(),
      email: text().notNull().unique(),
      emailVerified: boolean().notNull().default(false),
      image: text(),
      createdAt: when().notNull().defaultNow(),
      updatedAt: when().notNull().defaultNow(),
      /** The GitHub login the account is said to be; the login's own to set, never a person's input. */
      github: text(),
    })
    .enableRLS();
  const session = schema
    .table(
      "session",
      {
        id: text().primaryKey(),
        expiresAt: when().notNull(),
        token: text().notNull().unique(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
        ipAddress: text(),
        userAgent: text(),
        userId: text()
          .notNull()
          .references(() => user.id, { onDelete: "cascade" }),
      },
      (t) => [index().on(t.userId)],
    )
    .enableRLS();
  const account = schema
    .table(
      "account",
      {
        id: text().primaryKey(),
        accountId: text().notNull(),
        providerId: text().notNull(),
        userId: text()
          .notNull()
          .references(() => user.id, { onDelete: "cascade" }),
        accessToken: text(),
        refreshToken: text(),
        idToken: text(),
        accessTokenExpiresAt: when(),
        refreshTokenExpiresAt: when(),
        scope: text(),
        password: text(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
      },
      (t) => [index().on(t.userId)],
    )
    .enableRLS();
  const verification = schema
    .table(
      "verification",
      {
        id: text().primaryKey(),
        identifier: text().notNull(),
        value: text().notNull(),
        expiresAt: when().notNull(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
      },
      (t) => [index().on(t.identifier)],
    )
    .enableRLS();
  /** The rate limit's counts (`rateLimit.storage: "database"`), one row per key. */
  const rateLimit = schema
    .table("rate_limit", {
      id: text().primaryKey(),
      key: text().notNull().unique(),
      count: integer().notNull(),
      lastRequest: bigint({ mode: "number" }).notNull(),
    })
    .enableRLS();
  return { schema, user, session, account, verification, rateLimit };
}

/**
 * The staff login's OAuth provider's tables (`oauthPlugins`: oauth-provider, its JWT plugin's keys,
 * and the clients the CIMD plugin makes from their documents), beside `loginTables`' in its
 * `schema`, their users and sessions those tables'. The authorization codes are rows of
 * `verification`. Arrays are Postgres arrays and objects `jsonb`, as the Drizzle adapter writes
 * them on Postgres.
 */
export function oauthTables(
  schema: PgSchema,
  { user, session }: Pick<ReturnType<typeof loginTables>, "user" | "session">,
) {
  /** The access tokens' signing keys (the JWT plugin's), the private one encrypted with the login's key. */
  const jwks = schema
    .table("jwks", {
      id: text().primaryKey(),
      publicKey: text().notNull(),
      privateKey: text().notNull(),
      createdAt: when().notNull(),
      expiresAt: when(),
      alg: text(),
      crv: text(),
    })
    .enableRLS();
  /** A client: here only one the CIMD plugin made from its metadata document, its id that document's URL. */
  const oauthClient = schema
    .table(
      "oauth_client",
      {
        id: text().primaryKey(),
        clientId: text().notNull().unique(),
        clientSecret: text(),
        clientDiscoveryId: text(),
        disabled: boolean().default(false),
        skipConsent: boolean(),
        enableEndSession: boolean(),
        subjectType: text(),
        scopes: text().array(),
        clientCredentialsScopes: text().array().default([]),
        userId: text().references(() => user.id, { onDelete: "cascade" }),
        createdAt: when(),
        updatedAt: when(),
        name: text(),
        uri: text(),
        icon: text(),
        contacts: text().array(),
        tos: text(),
        policy: text(),
        softwareId: text(),
        softwareVersion: text(),
        softwareStatement: text(),
        redirectUris: text().array().notNull(),
        postLogoutRedirectUris: text().array(),
        backchannelLogoutUri: text(),
        backchannelLogoutSessionRequired: boolean(),
        tokenEndpointAuthMethod: text(),
        applicationType: text(),
        jwks: text(),
        jwksUri: text(),
        grantTypes: text().array(),
        responseTypes: text().array(),
        requirePKCE: boolean("require_pkce"),
        dpopBoundAccessTokens: boolean().default(false),
        referenceId: text(),
        metadata: jsonb(),
      },
      (t) => [index().on(t.userId)],
    )
    .enableRLS();
  /** A resource tokens are for, by its URL: this instance's `/mcp` at its configured agent address, the one row the staff login makes (and any a former address left). */
  const oauthResource = schema
    .table("oauth_resource", {
      id: text().primaryKey(),
      identifier: text().notNull().unique(),
      name: text().notNull(),
      accessTokenTtl: integer(),
      refreshTokenTtl: integer(),
      signingAlgorithm: text(),
      signingKeyId: text(),
      allowedScopes: text().array(),
      customClaims: jsonb(),
      dpopBoundAccessTokensRequired: boolean().default(false),
      disabled: boolean().default(false),
      createdAt: when(),
      updatedAt: when(),
      policyVersion: integer().default(1),
      metadata: jsonb(),
    })
    .enableRLS();
  const oauthClientResource = schema
    .table(
      "oauth_client_resource",
      {
        id: text().primaryKey(),
        clientId: text()
          .notNull()
          .references(() => oauthClient.clientId, { onDelete: "cascade" }),
        resourceId: text()
          .notNull()
          .references(() => oauthResource.identifier, { onDelete: "cascade" }),
        metadata: jsonb(),
        createdAt: when(),
      },
      (t) => [uniqueIndex().on(t.clientId, t.resourceId), index().on(t.resourceId)],
    )
    .enableRLS();
  /** Refresh tokens, hashed; each use rotates one. */
  const oauthRefreshToken = schema
    .table(
      "oauth_refresh_token",
      {
        id: text().primaryKey(),
        token: text().notNull().unique(),
        clientId: text()
          .notNull()
          .references(() => oauthClient.clientId, { onDelete: "cascade" }),
        sessionId: text().references(() => session.id, { onDelete: "set null" }),
        userId: text()
          .notNull()
          .references(() => user.id, { onDelete: "cascade" }),
        referenceId: text(),
        authorizationCodeId: text(),
        resources: text().array(),
        requestedUserInfoClaims: text().array(),
        expiresAt: when(),
        createdAt: when(),
        revoked: when(),
        rotatedAt: when(),
        rotationReplayResponse: text(),
        rotationReplayExpiresAt: when(),
        authTime: when(),
        confirmation: jsonb(),
        scopes: text().array().notNull(),
      },
      (t) => [index().on(t.clientId), index().on(t.sessionId), index().on(t.userId), index().on(t.authorizationCodeId)],
    )
    .enableRLS();
  /** Opaque access tokens, hashed: none is issued here, every one being a JWT for the resource asked. */
  const oauthAccessToken = schema
    .table(
      "oauth_access_token",
      {
        id: text().primaryKey(),
        token: text().unique(),
        clientId: text()
          .notNull()
          .references(() => oauthClient.clientId, { onDelete: "cascade" }),
        sessionId: text().references(() => session.id, { onDelete: "set null" }),
        userId: text().references(() => user.id, { onDelete: "cascade" }),
        referenceId: text(),
        authorizationCodeId: text(),
        resources: text().array(),
        requestedUserInfoClaims: text().array(),
        refreshId: text().references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
        expiresAt: when(),
        createdAt: when(),
        revoked: when(),
        confirmation: jsonb(),
        scopes: text().array().notNull(),
      },
      (t) => [
        index().on(t.clientId),
        index().on(t.sessionId),
        index().on(t.userId),
        index().on(t.authorizationCodeId),
        index().on(t.refreshId),
      ],
    )
    .enableRLS();
  /** What a person allowed a client, so the next sign-in of that client asks no more. */
  const oauthConsent = schema
    .table(
      "oauth_consent",
      {
        id: text().primaryKey(),
        clientId: text()
          .notNull()
          .references(() => oauthClient.clientId, { onDelete: "cascade" }),
        userId: text().references(() => user.id, { onDelete: "cascade" }),
        referenceId: text(),
        resources: text().array(),
        requestedUserInfoClaims: text().array(),
        scopes: text().array().notNull(),
        createdAt: when(),
        updatedAt: when(),
      },
      (t) => [index().on(t.clientId), index().on(t.userId)],
    )
    .enableRLS();
  /** A used client assertion's id until it expires (`private_key_jwt`, which no client here uses). */
  const oauthClientAssertion = schema
    .table("oauth_client_assertion", {
      id: text().primaryKey(),
      expiresAt: when().notNull(),
    })
    .enableRLS();
  return {
    jwks,
    oauthClient,
    oauthResource,
    oauthClientResource,
    oauthRefreshToken,
    oauthAccessToken,
    oauthConsent,
    oauthClientAssertion,
  };
}
