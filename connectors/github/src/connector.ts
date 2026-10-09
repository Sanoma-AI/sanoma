import { tfConnector } from "@sanoma/bridge/connector";
import { github_branch_protection, github_repository, github_team_membership, provider } from "./resources.gen.ts";

/**
 * GitHub's mark (the Invertocat), from GitHub's Octicons (`mark-github`, MIT), in GitHub's
 * near-black, and white on dark backgrounds.
 */
const mark = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${fill}" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;

/**
 * GitHub, through the `integrations/github` OpenTofu provider: the generated resource types,
 * what their schema does not say (how each is found), and who GitHub is. The connector, the
 * data-file constructors, the driver and the fake all come from this one record.
 */
export const githubTf = tfConnector({
  vendor: "github",
  provider,
  types: {
    repository: { tf: github_repository, title: "Repository", identity: "name", find: ({ name }) => name },
    branch_protection: {
      tf: github_branch_protection,
      title: "Branch protection rule",
      identity: "repository_id:pattern",
      find: ({ repository_id, pattern }) => `${repository_id}:${pattern}`,
    },
    team_membership: {
      tf: github_team_membership,
      title: "Team membership",
      identity: "team_id:username",
      find: ({ team_id, username }) => `${team_id}:${username}`,
    },
  },
  info: {
    title: "GitHub",
    logo: { svg: mark("#1F2328"), dark: mark("#FFFFFF") },
    package: "@sanoma/connector-github",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/github#readme",
  },
});
