import { database, host } from "./connector.ts";

/**
 * The constructors a data file declares the company's Sanoma Cloud database and host with:
 * `export const store = cloud.database({ region: "us-east" })` and
 * `export const host = cloud.host({ name: "acme", database: store })`, whose repository and branch apply gives it.
 */
export const cloud = { database, host };
