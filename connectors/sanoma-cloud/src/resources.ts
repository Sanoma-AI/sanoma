import { database, host, sandbox } from "./connector.ts";

/**
 * The constructors a data file declares the company's Sanoma Cloud database, host and agent boxes
 * with: `export const store = cloud.database({ region: "us-east" })`,
 * `export const host = cloud.host({ hostname: "acme.sanoma.work", database: store })`, whose
 * repository and branch apply gives it, and `export const box = cloud.sandbox({})`.
 */
export const cloud = { database, host, sandbox };
