// `pnpm run generate` writes src/generated/ from Resend's OpenAPI spec, pinned to a commit and
// cut to the operations the driver calls. A plain object, not `defineConfig`: Hey API runs
// through `pnpm dlx` with TypeScript 5, since TypeScript 7 has no compiler API for it to use.
export default {
  input: "https://raw.githubusercontent.com/resend/resend-openapi/8916b099d7f52b8552a2e1ef38a7f16fcd17864c/resend.yaml",
  output: { path: "src/generated", module: { extension: ".ts" }, postProcess: ["oxfmt"] },
  parser: {
    // The driver handles no webhooks, and the filters below drop the schemas they point to.
    patch: { input: (spec: { webhooks?: unknown }) => void delete spec.webhooks },
    filters: {
      operations: { include: ["POST /broadcasts", "GET /broadcasts/{id}", "POST /broadcasts/{id}/send"] },
    },
  },
  // `throwOnError` here types the SDK's replies as data only; the driver's client throws at run time.
  plugins: [{ name: "@hey-api/client-fetch", throwOnError: true }, "@hey-api/typescript", "@hey-api/sdk"],
};
