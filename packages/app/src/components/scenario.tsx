import type { ScenariosResponse } from "../api.ts";
import { Notice } from "./common.tsx";

// Why a feature file could not be read, on every page that lists scenarios.

/** Why each feature file that could not be read could not, from `scenariosQuery`'s `errors`. */
export function ScenarioErrors({ errors }: Pick<ScenariosResponse, "errors">) {
  return errors.map((e) => (
    <Notice key={`${e.file}:${e.message}`} variant="destructive">
      {/* A step no rule matches lists the known steps, one a line. */}
      <span className="whitespace-pre-wrap">Could not read a scenario: {e.message}</span>
    </Notice>
  ));
}
