// Where this company runs once it goes live: its database and its host on Sanoma Cloud, at its
// own address. Nothing is made until it goes live; until then it runs on this computer.
import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";

export const store = cloud.database({ name: "company" });
export const host = cloud.host({ name: "company", database: store, hostname: "company.sanoma.work" });

export default [store, host];
