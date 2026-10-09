// Web types the repo's lib (es2024 and Node's types, no DOM) leaves out, which generated
// clients name. Included by the root tsconfig and by each connector's build.

/** What a `fetch` body may be: the DOM's `BodyInit`. */
type BodyInit = NonNullable<RequestInit["body"]>;
