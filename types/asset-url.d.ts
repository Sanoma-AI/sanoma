// A Vite `?url` import, for the app's tests the root tsconfig checks: the app's own config takes
// Vite's client types whole (`vite/client`), which the root leaves out for its Node code.

/** The asset's URL: a `data:` URL for a small file, else its path in the build. */
declare module "*?url" {
  const src: string;
  export default src;
}
