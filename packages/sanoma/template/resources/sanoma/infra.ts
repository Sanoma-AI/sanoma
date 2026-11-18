// Where this company runs once it goes live: its database and its host on Sanoma Cloud, at its
// own address. Nothing is made until it goes live; until then it runs on this computer.
import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";

export const store = cloud.database({ region: "us-east" });
export const host = cloud.host({ hostname: "company.sanoma.work", database: store });

export default [store, host];
