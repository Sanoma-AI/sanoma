import { defineConnector } from "sanoma/workflows";

/** Better Auth's mark, from its repository (`demo/nextjs/components/logo.tsx`), in black or white. */
const mark = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 45"><path fill="${fill}" fill-rule="evenodd" d="M0 0H15V15H30V30H15V45H0V30V15V0ZM45 30V15H30V0H45H60V15V30V45H45H30V30H45Z"/></svg>`;

/**
 * Better Auth: no operations, no driver and no credential; its login half is in `login.ts`. Part of
 * `sanoma`, so its vendor's facts are written here, not read from a package.json of its own.
 */
export const betterAuthOps = defineConnector(
  "better-auth",
  {},
  {
    title: "Better Auth",
    logo: { svg: mark("black"), dark: mark("white") },
    package: "sanoma",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/packages/sanoma/better-auth#readme",
  },
);
