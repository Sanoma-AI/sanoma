import { withSetup } from "@sanoma-ai/workflows";
import { agent37Backend } from "./backend.ts";
import { agent37Ops } from "./connector.ts";
import { agent37Driver } from "./driver.ts";
import { fakeAgent37 } from "./fake.ts";

/**
 * Agent37 Cloud: the resource type `agent37.instance`, which meets the `Sandbox` contract, and
 * its backend (`agent37Backend`), which opens a box as one Agent37 instance each, made, woken or
 * started as it needs, with commands and files over SSH. It carries its driver (`agent37Driver`),
 * which reads its key when called, and its fake (`fakeAgent37`).
 */
export const agent37 = withSetup(agent37Ops, {
  driver: agent37Driver,
  fake: fakeAgent37,
  sandbox: (context) => agent37Backend(context),
});
