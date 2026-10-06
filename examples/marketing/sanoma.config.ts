import { join } from "node:path";
import { fakeMarketingVendors } from "@sanoma/testing";
import announce from "./workflows/announce.ts";

// Fake vendors until the real connectors land (MVP phase 2). Their state is kept in
// .sanoma/fake-vendors.json so you can see what each run published.
const vendors = fakeMarketingVendors({ file: join(import.meta.dirname, ".sanoma", "fake-vendors.json") });

export default {
  workflows: [announce],
  drivers: vendors.drivers,
};
