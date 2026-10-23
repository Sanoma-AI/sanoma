// `pnpm run generate` writes src/generated/ from Exa's OpenAPI spec, pinned to a commit and
// cut to the operations the driver calls. A plain object, not `defineConfig`: Hey API runs
// through `pnpm dlx` with TypeScript 5, since TypeScript 7 has no compiler API for it to use.
export default {
  input:
    "https://raw.githubusercontent.com/exa-labs/openapi-spec/57d917823aa0cec02385104dc3bb795cdf5d7da8/exa-openapi-spec.yaml",
  output: { path: "src/generated", module: { extension: ".ts" }, postProcess: ["oxfmt"] },
  parser: {
    filters: {
      operations: { include: ["POST /search", "POST /contents", "POST /findSimilar", "POST /answer"] },
    },
  },
  // `throwOnError` here types the SDK's replies as data only; the driver's client throws at run time.
  plugins: [{ name: "@hey-api/client-fetch", throwOnError: true }, "@hey-api/typescript", "@hey-api/sdk"],
};
