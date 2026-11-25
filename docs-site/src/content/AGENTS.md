# Writing Sanoma docs

Write for the teammate using the company app, the person setting up the company, or the developer changing its repository. Start with the decision the reader needs to make or the task they came to do. Use the repository’s [copywriting guide](../../../.agents/skills/copywriting/SKILL.md) for voice and the [docs-site README](../../README.md) for page format and links.

## Choose the page’s purpose

Give each page one primary job. Picture the reader at the moment they open it. Are they practising a skill or using it on their own company repo? Do they need an action to take or information to think with? These two questions form the [Diátaxis compass](https://diataxis.fr/compass/). For an introduction, see [GitHub’s guide to developer documentation](https://github.blog/developer-skills/documentation-done-right-a-developers-guide/).

| Form        | How to write it                                                                                                                                     | Sanoma example                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tutorial    | Choose one repeatable exercise. Tell the learner what to look for after each meaningful step so they can tell whether it worked.                    | Take a reader from an empty directory to their first running company.                         |
| How-to      | Guide someone doing a real task in their own repo. Assume familiarity with the tools and give alternatives where their setup affects the next step. | Show how to preview a site edit and which address to open if the site is public.              |
| Explanation | Answer a “why” question. Use one concrete case to show how the parts relate.                                                                        | Explain why a held call checks both the covered operation and the approver.                   |
| Reference   | Put the exact name beside its behavior. Present related entries in the same order so readers can compare them.                                      | For each command, give its syntax, what it writes or prints, and when it exits with an error. |

For an existing page, start with one passage where the reader could get stuck. If a procedure pauses to explain a design decision, keep the condition that affects the next step and link to the reasoning. A single paragraph can be a complete improvement. See the [Diátaxis editing workflow](https://diataxis.fr/how-to-use-diataxis/).

## Where does this page belong?

Choose the entry point a reader would recognize before choosing a folder. The homepage offers three paths.

- **Set up a company** covers a new or existing repository. Link both setup routes to the first sandbox run. A tutorial should use a shipped scenario and tell the learner which ledger result to look for.
- **Use your company’s app** covers tasks a teammate can complete from the app. Start with the screen and the action. Include the label on the control and what the reader will see afterward.
- **Build with Sanoma** covers changes to workflows, sites, and connectors. A workflow guide can assume an installed connector. Put driver implementation and fake behavior under **Building connectors**. Link to the generated catalog for operation signatures.

Use **People and policies**, **Testing**, **Hosting**, or **Reference** when the question applies across those paths.

Repeat the detail someone needs for the next action. The first-run tutorial can say that the scenario supplies the inputs and tell the learner which values to expect. Keep the full procedure, option list, or API contract in one place and link to it where a reader needs more.

Split a section when you can name a different reader or question it serves. Someone writing a scenario needs a working example and a way to check it. Someone looking up a step needs its exact syntax and matching rules. Keep the example and its check together, and put the lookup table in the [scenario step reference](docs/reference/scenario-steps.md).

For example, a teammate deciding a request needs [Review an approval](docs/using-the-app/approvals.md). A workflow author asking why the run waits needs [Approvals](docs/workflows/approvals.md). Someone handling a timeout in code needs the arguments, return value, and errors in [Approval decisions](docs/reference/approval-decisions.md).

When you move a section, update the sidebar and the pages that send readers there. Keep the old URL and heading usable for bookmarked links. Read the previous and next links as a journey, especially where two setup routes converge.

Add troubleshooting when there is a known symptom and a specific recovery. Use a FAQ for recurring questions with short answers. GitHub’s [internal documentation example](https://github.com/github/internal-documentation-example) shows how headings and a consistent entry point help readers find a task.

## Help readers scan

- Give each sentence one main idea. Split where the actor or action changes. Keep a condition beside the action it governs. For example, “If the worker is offline, your approval decision stays queued. The run reads it when the worker resumes.” See [Google Technical Writing on short sentences](https://developers.google.com/tech-writing/one/short-sentences).
- Give each paragraph one job. Lead with the action or answer and keep the details needed to use it together. Start a new paragraph when the reader’s question changes. If an app procedure turns into an explanation of worker behavior, link to the explanation at that point. See [Google Technical Writing on paragraphs](https://developers.google.com/tech-writing/one/paragraphs) and the [Diátaxis editing workflow](https://diataxis.fr/how-to-use-diataxis/).
- Use sentence case for titles and headings. Name the task (“Start a company”), the thing a reader will look up (“Approvals”), or the question a section answers (“What an approval covers”).
- Make the frontmatter description useful on its own. Say what the reader can do or what the feature does. Skip openings like “This guide explains…”.
- Put the answer or first action near the top. Keep the common case together and link to background or uncommon cases where a reader might need them.
- Use numbered steps for a sequence and a table for a lookup. Read the headings alone: can you find the action you came for? See [Microsoft’s guidance on scannable content](https://learn.microsoft.com/en-us/style-guide/scannable-content/).

## Say who does what

- Address the reader as “you” when they can take the action. Use an imperative for a step (“Open an empty directory”). When permissions matter, name the person, group, or agent that can act.
- Use the present tense for runtime behavior. Give the action a subject and an observable result. “The policy holds the call until the finance lead approves it” tells the reader who decides and what is waiting. Cut adjectives such as “seamless” that add no behavior.
- Keep Sanoma’s vocabulary precise. A workflow can have many runs. A connector exposes operations. Say whether a policy holds a workflow start or a particular call. Use backticks for literal commands, paths, operation IDs, and field names.
- Explain unfamiliar terms and spell out unfamiliar acronyms on first use. For a reader’s first encounter with the ledger, call it “the record of what happened during a run.”
- Keep conditions beside the behavior they qualify. For example, “By convention, declare people in `resources/people.ts`” preserves a detail that “You must declare people in `resources/people.ts`” loses. Check defaults, permissions, and failure behavior against the relevant source before changing a claim.

## Make examples carry their weight

Use the smallest example that shows the decision or result. Keep the same people, operations, and filenames from the prose through the snippet. After a command, name the file it writes, the output to expect, or the next action that output enables.

For models in this collection, see how [Start a company](docs/start/start-a-company.md) puts the command first, [Approvals](docs/workflows/approvals.md) names who can decide, and [Test a workflow with a scenario](docs/testing/scenarios.md) shows the expected outcome in a Gherkin example.
