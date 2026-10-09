import { z } from "zod";
import { github } from "@sanoma/connector-github/resources";

export const web = github.repository({ name: "web", description: z.string().parse("Site") });
