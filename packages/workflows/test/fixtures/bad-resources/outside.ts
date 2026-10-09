import { github } from "@sanoma/connector-github/resources";
import { website } from "../resources/identity/github.ts";

export const websiteMain = github.branch_protection({ repository_id: website, pattern: "main" });
