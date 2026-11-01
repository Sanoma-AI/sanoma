import { database, host } from "./connector.ts";

/**
 * The constructors a data file declares the company's Sanoma Cloud database and host with:
 * `export const store = cloud.database({ region: "us-east" })` and
 * `export const host = cloud.host({ source: repo, ref: "main", domains: { app: "acme.sanoma.work" } })`.
 */
export const cloud = { database, host };
