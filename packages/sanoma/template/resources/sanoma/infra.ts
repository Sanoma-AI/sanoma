// Where this company runs once it goes live: its database and its host on Sanoma Cloud, at its
// own address. Nothing is made until it goes live; until then it runs on this computer.
import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";

const slug = "company";

export const store = cloud.database({ name: slug });
export const host = cloud.host({ name: slug, database: store, hostname: `${slug}.sanoma.work` });

export default [store, host];
