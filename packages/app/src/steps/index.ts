import type { AppSteps } from "@sanoma-ai/workflows";
import { connectExisting } from "./connect.ts";
import { goLive, goLiveHost } from "./go-live.ts";
import { adopt, patch } from "./writes.ts";

// `@sanoma-ai/app/steps`: the app's own actions on the company's repository, which the worker
// runs in the runs of their built-in workflows (`WorkerOptions.app`): the launcher's workers are
// given them. Node only: they write files and run git; the app's handler never imports them.

/** The app's steps, one per built-in workflow of the app's (`AppSteps`). */
export const appSteps: AppSteps = { adopt, patch, goLive, goLiveHost, connectExisting };
