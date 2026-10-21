// The dev server's stand-in importer (`devPlugins` in build.ts): on the server, a company file's
// import of React, TanStack or the app becomes an import of this file's id with the specifier in
// its query, which resolves from here, to the app's own copy. Never loaded itself.
// oxlint-disable-next-line unicorn/require-module-specifiers -- a module, with nothing in it
export {};
