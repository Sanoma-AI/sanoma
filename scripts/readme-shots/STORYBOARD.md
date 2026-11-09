# Intro demo: a launch desk for marketing

Status: storyboard, not a recorded demo. The root README currently shows the existing workflow GIF. This plan replaces it with a demonstration of building a site and workflow, reviewing the change, and running it with permissions and integrations.

## The story

Dana, a marketing teammate, wants one page to prepare an announcement. She uses Claude Code on her own subscription to ask Sanoma for the tool. An engineer reviews the draft's code and permissions before publishing the change. Dana then submits an announcement; the marketing lead approves the external actions, and the workflow publishes to Ghost and sends an email through Resend.

Use a fictional team, Paperplane Studio, and an announcement titled “Our November workshop.” Keep the same title visible in the form, approval and run so the viewer can follow one item through the whole story.

The opening shows the finished page immediately. The recording then shows how it was built. The two approvals have different labels throughout: **Approve the code change** and **Approve this announcement**.

## Format and placement

- Record a 60-second video with captions that make sense without audio. An optional voiceover can read the captions; it should add no claims absent from the screen.
- Cut a 22-second GIF from the same footage for the README, directly below the opening copy and links. Keep the full video behind a linked thumbnail or “Watch the 60-second demo” link once an actual video URL exists.
- Capture at 1440 × 900. Frame the relevant panel so labels remain readable at roughly 900 px wide in a README. Export the video as H.264 MP4; export a reduced-palette GIF at about 960 px wide and 10 fps, aiming below 8 MB. Check legibility and file size after export rather than treating those as fixed guarantees.
- Use real app footage with simple cuts, restrained cursor movement and one caption at a time. Hold the permissions and approval screens long enough to read them. Label shortened agent/build waits “Time condensed.”

## The 60-second storyboard

| Time    | What the viewer sees                                                                                                                                                                                         | Caption / optional narration                           | What it demonstrates                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| 0–4 s   | The completed **Launch desk** site: title and body fields, a submit button, and a short explanation that publishing requires the marketing lead. No logo animation before the product.                       | “A launch desk your marketing team can use.”           | The outcome is a usable page.                                              |
| 4–10 s  | Cut back to Dana's chat. Open **Your own plan**, choose **Claude Code**, then return to the composer. Use an account already signed in; omit login codes and credentials.                                    | “Build with your existing Claude subscription.”        | The AI account is Dana's own, on a plan that includes Claude Code.         |
| 10–18 s | Enter the request below and send it. Show a brief real portion of the agent working, then cut forward with a visible “Time condensed” label.                                                                 | “Describe the page, the tools and who must approve.”   | A coworker asks for the tool in ordinary language.                         |
| 18–26 s | The real draft card and checks; then the changed site route, workflow and policy files. Hold on the branch and successful checks.                                                                            | “The agent builds a draft in your team's Git repo.”    | The result is code that the team can inspect.                              |
| 26–35 s | Cut to the engineer's Changes page. Show the permission comparison and the rule requiring the marketing lead for Ghost publishing and Resend sending. Show the linked PR and approve **Publish the change**. | “Review the code and permissions before publishing.”   | Code approval is separate from approval of external actions.               |
| 35–43 s | Back as Dana, open the now-published Launch desk. Fill in “Our November workshop” and submit. Open the run: drafting is complete and the approval is pending.                                                | “Your coworker runs the tool. Publishing waits.”       | The page starts a real workflow; the vendor actions have not happened yet. |
| 43–52 s | Cut to the marketing lead's Inbox. Open the matching announcement, show the content and the Ghost/Resend operations covered by the approval, and approve. Follow the run graph as both actions complete.     | “The marketing lead approves this announcement.”       | Permission rules affect execution, beyond the earlier code review.         |
| 52–57 s | The completed run and ledger: Ghost publish, Resend email send, approval and results. Keep the announcement title visible.                                                                                   | “Your tools do the work. Sanoma keeps the record.”     | Two integrations and an inspectable execution history.                     |
| 57–60 s | Return to the finished Launch desk, with the Sanoma headline and a small “Try it from the README” caption.                                                                                                   | “Workflows and sites for your nontechnical coworkers.” | The closing frame returns to the opening for a clean loop.                 |

### The request shown in chat

> Build a launch desk for our marketing team. Give us a page with a title and announcement body. A workflow should create a draft in Ghost, wait for the marketing lead to approve it, then publish the post and send the announcement through Resend to our demo recipient. Marketing can start the workflow, but publishing and sending must wait for approval. Use our existing Ghost and Resend connections. Add checks for the approval behavior.

The recipient, sender and connection names must be supplied in the demo fixture rather than guessed by the agent. Use invented content and simulated vendor calls for the default recording.

## The 22-second README GIF

Use selected moments from the full recording, with the context retained in captions:

| Time    | Shot                                                                   | Caption                                              |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| 0–3 s   | Finished Launch desk, then the selected Claude Code agent.             | “A tool for marketing. Built with your Claude plan.” |
| 3–7 s   | The request, then the checked draft; indicate the cut in elapsed time. | “Ask for a page and workflow.”                       |
| 7–12 s  | Engineer's permission comparison and code-change approval.             | “Review the code and permissions.”                   |
| 12–16 s | Dana submits; the run waits for the marketing lead.                    | “External actions wait for approval.”                |
| 16–20 s | Marketing lead approves; Ghost and Resend steps complete.              | “Use the tools your team already has.”               |
| 20–22 s | Completed run, then the opening page.                                  | “See what ran.”                                      |

## What must exist before recording

Use the current [capture script](capture.ts) and [fixture setup](shots.ts) as a starting point. They already exercise the announce workflow, Ghost fake, an internal site, the Inbox and the run ledger. They do not yet record agent drafting, the change-review flow or Resend. Those scenes require extending the fixture and capture flow; this document does not claim they are recorded.

Prepare these pieces:

1. A disposable demo company with three clearly named roles: Dana in marketing, an engineer in admin, and the marketing lead as workflow approver. Give it a Git remote configured for the app's real change flow. Production repositories and customer data are not recording fixtures.
2. A Ghost connection and a Resend connection backed by their fakes. The new workflow declares `ghost.post.create`, `ghost.post.publish`, `resend.emails.send` and `approval`. Its approval covers both external actions. Configure the relevant policies and verify that both actions wait, rejection makes neither call, and approval permits them. Show the actual rules and decisions that this fixture produces.
3. One actual recorded agent session creating the draft from the request, with the resulting code and checks kept for reproducibility. Do not manufacture chat messages, green checks or a claim about how long generation took. If the agent needs a correction, edit for length without disguising the correction as an uninterrupted first try.
4. A real local site after the change is accepted. Show the changed files before acceptance; do not invent a live draft-preview interface. Local execution proves this story without claiming a public deployment.
5. A persistent **Demo · simulated service calls** label during vendor, approval and run scenes, including the short GIF. The existing capture drives fakes behind the live connector and displays misleading “Live vendors” text; the replacement must visibly disclose the simulation. Do not show a fake external vendor dashboard as evidence of a live publish or delivery.

A successful Resend call demonstrates that the send request returned, not that an email reached a person's inbox. If a later recording uses real test accounts, capture the actual outcome and replace the simulation label only for those verified scenes.

## Existing tools: what to say and show

The central example uses Ghost and Resend because those operations already exist. Show **Your own plan → Claude Code** to make existing AI subscriptions concrete; use a [Claude plan that includes Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan), with its normal terms and limits. This is separate from the default agent's Anthropic API-key billing.

Stripe can appear in supporting copy as an existing connector, but it currently reads products and webhook endpoints only. Do not show charging a card, refunds or subscription management. PostHog has no bundled connector in this repo; it is an example of an integration to add, not an already-working integration to show in the launch footage.

## Recording acceptance

The final footage must make the request, generated files, code review, runtime approval and two vendor operations legible without sound. Verify that the GIF renders from the README, the full-video link works, captions remain readable at README width, and simulated calls and condensed time are labeled. Preserve the workflow code block used by the current capture script. Update the README caption and `scripts/readme-shots/README.md` only when the replacement media and its capture procedure actually exist.
