import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AppStepContext, type Chat, isDirect, type Principal, type SanomaConfig, VENDOR } from "sanoma/workflows";
import { readPeople } from "sanoma/workflows/describe";
import { type ChatMessage, textOf } from "../../lib/chat.ts";
import { ASKS_LINE } from "./transcript.ts";

// Our loop's system prompt: the rules, then what it is told of the company: the company at a
// glance, its AGENTS.md, its connectors and their operations' effects, and the person's open
// drafts. And a coding agent's (`harnessInstructions`), the company at a glance too, which reads
// the repository's AGENTS.md itself.

/** The most of the company's AGENTS.md the prompt carries, in characters. */
const AGENTS_LIMIT = 40_000;

/** Who the agent is, for either engine. */
const ROLE =
  "You are the operator agent of a company whose operations run on Sanoma, a framework for full-stack business apps. The company's apps are code in this repository (workflows/, resources/, policies/, sites/, scenarios/, and apps/<name>/ holding the same for each app).";

/** The rules either engine ends on. */
const COMMON_RULES = `- The person saves the draft from its card (Save), which puts it to work, or with a review first when the company reviews its changes; they can undo a save there too. Until they save it, nothing you drafted runs: never say a change is live.
- Never ask for, read or write a credential: keys are set on the app's connector pages.
- For a missing or expired connection, send the person to /connectors/<vendor> for secure input. Describe only account requirements and status. Never ask them to paste a key, password or OAuth token into chat.
- Answer in plain words, briefly. Say what you changed and where.
- When you introduce yourself, and after you make a change, suggest what the person could ask you next: end your reply with a line that says only "${ASKS_LINE}", then one ask to a line, each starting with "- " and worded as the person would type it (after a change, the two most useful). Otherwise suggest none.`;

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

/** Each vendor's title, its first connector's, as the app's pages name it. */
function vendorTitles(config: SanomaConfig): Map<string, string> {
  const titles = new Map<string, string>();
  for (const connector of config.connectors) {
    const { id, info } = connector[VENDOR];
    if (!titles.has(id)) titles.set(id, info?.title ?? id);
  }
  return titles;
}

/** Names as a list, or "none". */
const namesOrNone = (names: string[]) => (names.length ? names.join(", ") : "none");

/** The company in one paragraph, what the agent says it read when it speaks first: its workflows, connectors and people. */
function atAGlance(
  { config, resolved }: Pick<AppStepContext, "config" | "resolved">,
  titles: Map<string, string>,
): string {
  // The people the runtime admits, from the config's root.
  const { people } = readPeople(resolved.root);
  const named = (type: string) =>
    people.filter((r) => r.type === type).map((r) => (typeof r.desired.name === "string" ? r.desired.name : r.name));
  return `The company at a glance: its workflows: ${namesOrNone((config.workflows ?? []).map((wf) => wf.title ?? wf.name))}; its connectors: ${namesOrNone([...titles.values()])}; its people: ${namesOrNone(named("person"))}; its groups: ${namesOrNone(named("group"))}.`;
}

/**
 * A coding agent's instructions for `principal`'s turn in `chat`: the rules, who it acts for, and
 * the chat's earlier messages (`history`, their text), since each turn starts a new session of it.
 */
export function harnessInstructions(
  step: Pick<AppStepContext, "config" | "resolved">,
  principal: Principal,
  chat: Chat,
  history: ChatMessage[],
): string {
  const sections = [
    HARNESS_RULES,
    actingFor(step.resolved.appName, principal, chat),
    atAGlance(step, vendorTitles(step.config)),
  ];
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
export async function instructions(step: AppStepContext, principal: Principal, chat: Chat): Promise<string> {
  const { config, resolved } = step;
  const titles = vendorTitles(config);
  const sections = [RULES, actingFor(resolved.appName, principal, chat), atAGlance(step, titles)];
  const [guide, drafts] = await Promise.all([companyGuide(step), openDrafts(step, principal)]);
  if (guide) sections.push(`The company's AGENTS.md:\n\n${guide}`);
  const ops = [...resolved.ops.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  const connectors = [...Map.groupBy(ops, (op) => op.vendor)].map(([vendor, of]) => {
    const listed = of.map(
      (op) => `  - ${op.id} (${op.effect}${op.effect === "read" && isDirect(op, resolved.types) ? ", a lookup" : ""})`,
    );
    return `- ${titles.get(vendor) ?? vendor} (${vendor}):\n${listed.join("\n")}`;
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
async function companyGuide({ source, resolved }: AppStepContext): Promise<string | undefined> {
  const root = source?.root ?? resolved.root;
  const text = root && (await readFile(join(root, "AGENTS.md"), "utf8").catch(() => undefined));
  return text && text.length > AGENTS_LIMIT ? `${text.slice(0, AGENTS_LIMIT)}\n[cut]` : text;
}

/** The person's chats whose drafts are still open (`Source.drafts`). */
async function openDrafts({ source, client }: AppStepContext, principal: Principal): Promise<Chat[]> {
  if (!source?.drafts) return [];
  const [open, chats] = await Promise.all([
    source.drafts().then((ids) => new Set(ids)),
    client.chats.list(principal.id),
  ]);
  return chats.filter((c) => c.draftId !== undefined && open.has(c.draftId));
}
