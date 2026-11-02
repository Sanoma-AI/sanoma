// What the Worker's build puts in place of a package the runtime imports but never calls there
// (`OPTIONAL` in `optional.ts`), which is not bundled: CommonJS, so any import of it binds, and
// any use of what it gives throws.
const missing = (name) => () => {
  throw new Error(`${name} is not on the Cloudflare Worker: nothing serving a site calls it`);
};
module.exports = new Proxy(
  {},
  {
    get: (_target, key) =>
      typeof key === "string" && key !== "__esModule" && key !== "then" ? missing(key) : undefined,
  },
);
