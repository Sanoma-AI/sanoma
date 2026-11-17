// The connectors as scripts/reference.ts wrote them, for the pages that draw them.
import type { ConnectorReference } from "../../scripts/reference.ts";
import data from "../data/reference.json";

export type { ConnectorReference };

export const connectors = data as ConnectorReference[];
