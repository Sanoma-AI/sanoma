// The deployment's credential store and explicit bootstrap bindings; no secret values. A hosted
// company's sign-up may replace this file with its own store; a deployment of your own selects
// its store here without changing connector references.
export const secrets = {
  bindings: {
    // Host deployment may deliver these bootstrap keys; they are never stored in the database.
    SANOMA_SIGNING_KEY: { bootstrap: "SANOMA_SIGNING_KEY" },
    SANOMA_SECRETS_KEY: { bootstrap: "SANOMA_SECRETS_KEY" },
    // A host gives its Cloud token as a variable; on a laptop it is stored from the Sanoma Cloud
    // connector page, so it is read from the environment only where the variable is set.
    ...(process.env.SANOMA_CLOUD_TOKEN ? { SANOMA_CLOUD_TOKEN: { env: "SANOMA_CLOUD_TOKEN" } } : {}),
  },
} as const;
