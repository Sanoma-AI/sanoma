import { join } from "node:path";

/**
 * A program Windows ships, by its path: `Path` may not have System32, and Git for Windows can put
 * its own `tar` ahead of it, which reads `C:\…` as a remote host.
 */
export const system32 = (program: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", program);
