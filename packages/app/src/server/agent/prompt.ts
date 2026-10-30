import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chat, Principal } from "@sanoma-ai/workflows";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, textOf } from "../../lib/chat.ts";

// Our loop's system prompt: the rules, then what it is told of the company: its AGENTS.md, its
// connectors and their operations' effects, and the person's open drafts. And a coding agent's
// (`harnessInstructions`), which reads the repository's AGENTS.md itself.

/** The most of the company's AGENTS.md the prompt carries, in characters. */
const AGENTS_LIMIT = 40_000;

/** Who the agent is, for either engine. */
const ROLE =
  "You are the operator agent of a company whose operations run on Sanoma: workflow automation where every workflow is code in this repository (workflows/, resources/, policies/, sites/, scenarios/, and apps/<name>/ holding the same for each app).";

/** The rules either engine ends on. */
const COMMON_RULES = `- The person reviews the draft and merges its branch by hand; the live instance keeps running the old code until it restarts. Never say a change is live.
- Never ask for, read or write a credential: keys are set on the app's connector pages.
- For a missing or expired connection, send the person to /connectors/<vendor> for secure input. Describe only account requirements and status. Never ask them to paste a key, password or OAuth token into chat.
- Answer in plain words, briefly. Say what you changed and where.`;

const RULES = `${ROLE}

How you work:
- You change nothing live. Your edits go to your draft: a branch of its own (draft/<this chat's id>), checked out apart from the live one, made from the live checkout at your first edit. Edit only with write_file and edit_file; each edit is committed on the draft as you make it.
- Read before you edit: list_files, read_file and grep read the repository as committed (your draft, once you have edited).
- take_app takes an app into your draft, a git merge of its source repository that lands as apps/<name>/; update_app merges its source's new commits. A file git could not merge is committed with its conflict markers: resolve each with edit_file, keeping the company's changes and the source's (in package.json, the company's fields with the app's dependencies added). A dependency the app adds is installed only when the person installs the merged branch, so until then the checks fail on it: say so.
- After your edits, run run_checks and fix what it finds until it passes, or say plainly what still fails and why.
- lookup calls an operation whose effect is read, as the person, through the company's policy. One the policy holds waits for its approver's decision; say so and what you asked for.
${COMMON_RULES}`;

/** The most of the chat's earlier messages a coding agent is told, in characters (the latest kept). */
const HISTORY_LIMIT = 40_000;

const HARNESS_RULES = `${ROLE} Read its AGENTS.md first.

How you work:
- Your working directory is your draft: a checkout of a branch of its own (draft/<this chat's id>), apart from the live one. You change nothing live.
- Edit files in it. Writing under .git or node_modules, or outside it, is refused. Shell commands are refused until previews exist, so taking or updating an app (a git merge of its source) is the Sanoma engine's: say so if asked.
- When your turn ends, your edits are committed on the draft and its checks (sanoma check) run; the person sees their result, and you see it with the chat's earlier messages in your next turn.
${COMMON_RULES}`;

/** Who the agent acts for, in which company and chat. */
const actingFor = (appName: string, principal: Principal, chat: Chat) =>
  `The company: ${appName}. You act for ${principal.id}. This chat is ${chat.id}.`;

/**
 * A coding agent's instructions for `principal`'s turn in `chat`: the rules, who it acts for, and
 * the chat's earlier messages (`history`, their text), since each turn starts a new session of it.
 */
export function harnessInstructions(app: AppContext, principal: Principal, chat: Chat, history: ChatMessage[]): string {
  const sections = [HARNESS_RULES, actingFor(app.description.appName, principal, chat)];
  // Whole messages, the latest first, until the limit (the latest one always).
  const said: string[] = [];
  let size = 0;
  for (const message of history.toReversed()) {
    const line = `${message.role === "user" ? principal.id : "You"}: ${spoken(message)}`;
    size += line.length;
    if (said.length && size > HISTORY_LIMIT) break;
    said.unshift(line);
  }
  if (said.length) sections.push(`Earlier in this chat:\n\n${said.join("\n\n")}`);
  return sections.join("\n\n");
}

/** A message's text, and the checks its draft card shows. */
function spoken(message: ChatMessage): string {
  const checked = message.parts.findLast((part) => part.type === "data-draft")?.data.checks;
  const text = textOf(message, "\n");
  if (!checked) return text;
  return `${text}\n[The draft's checks: ${checked.ok ? "passed" : `failed: ${checked.problems.join("; ")}`}]`;
}

/** The loop's instructions for `principal`'s turn in `chat`. */
export async function instructions(app: AppContext, principal: Principal, chat: Chat): Promise<string> {
  const { description } = app;
  const sections = [RULES, actingFor(description.appName, principal, chat)];
  const [guide, drafts] = await Promise.all([companyGuide(app), openDrafts(app, principal)]);
  if (guide) sections.push(`The company's AGENTS.md:\n\n${guide}`);
  const byVendor = Map.groupBy(description.ops, (op) => op.vendor);
  const connectors = [...byVendor].map(([vendor, ops]) => {
    const title = description.vendors[vendor]?.title ?? vendor;
    const listed = ops.map(
      (op) => `  - ${op.id} (${op.effect}${op.effect === "read" && op.direct ? ", a lookup" : ""})`,
    );
    return `- ${title} (${vendor}):\n${listed.join("\n")}`;
  });
  if (connectors.length)
    sections.push(`The installed connectors and their operations' effects:\n${connectors.join("\n")}`);
  sections.push(
    drafts.length
      ? `${principal.id}'s open drafts (branches not yet merged or deleted):\n${drafts.map((c) => `- draft/${c.draftId}: ${c.title}`).join("\n")}`
      : `${principal.id} has no open drafts.`,
  );
  return sections.join("\n\n");
}

/** The repository's AGENTS.md, cut to its limit; none without one. */
async function companyGuide({ source, resolved }: AppContext): Promise<string | undefined> {
  const root = source?.root ?? resolved.root;
  const text = root && (await readFile(join(root, "AGENTS.md"), "utf8").catch(() => undefined));
  return text && text.length > AGENTS_LIMIT ? `${text.slice(0, AGENTS_LIMIT)}\n[cut]` : text;
}

/** The person's chats whose drafts are still open (`Source.drafts`). */
async function openDrafts({ source, client }: AppContext, principal: Principal): Promise<Chat[]> {
  if (!source?.drafts) return [];
  const [open, chats] = await Promise.all([
    source.drafts().then((ids) => new Set(ids)),
    client.chats.list(principal.id),
  ]);
  return chats.filter((c) => c.draftId !== undefined && open.has(c.draftId));
}
