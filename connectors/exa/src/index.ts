import { withSetup } from "@sanoma-ai/workflows";
import { exaOps } from "./connector.ts";
import { exaDriver } from "./driver.ts";
import { fakeExa } from "./fake.ts";
import { exaSteps } from "./steps.ts";

/**
 * Exa web search: `web.search`, `web.getContents`, `web.findSimilar` and `web.answer`. It carries
 * its live driver (`exaDriver`), which reads its key when called, its fake (`fakeExa`), of which
 * each sandbox run makes its own, and its steps for Gherkin tests (`exaSteps`).
 */
export const exa = withSetup(exaOps, { driver: exaDriver, fake: fakeExa, steps: exaSteps });
