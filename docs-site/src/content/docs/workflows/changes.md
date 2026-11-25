---
title: Changes
description: "How a draft becomes a reviewed and published change, and what saving does in a local company."
sidebar:
  order: 11
---

A review remote lets Sanoma check a specific revision before merging a draft. Without a remote managed by a review connector, saving merges the checked draft locally. To decide a change in the app, [review the draft](/using-the-app/changes/).

## Drafts and local saves

- **The draft.** The chat commits its edits to `draft/<id>`, where `<id>` is the chat ID. Sanoma’s `localGitSource` keeps its worktree in `.sanoma/drafts/<id>`, separate from the live checkout. The draft card lists the changed files and the result of `sanoma check`. Once a commit passes the checks, the card offers **Save to** the company and, if the repo has a remote, **Review**.
- **Save** starts the built-in `save-draft` workflow on the draft, as the chat's person (`SanomaClient.saveDraft({ id, title, head?, page? }, { startedBy })`; the run is `save:<id>`, and `save:<id>~2` once that one has ended; `SanomaClient.saves(id)` lists them with their outputs).

  Without a remote a connector reviews changes on, its step merges the draft at `head`, the commit the card showed, into `main` as one commit titled as the chat and closes the draft, in one git write (`Source.merge`: a squash in the checkout naming the run in a `Sanoma-Save` trailer, refused once the draft moved on from that commit, while the checkout has uncommitted changes, or when the two conflict), pushes `main` to `origin` when there is one (a push it refuses is the output's `notPushed`; the save stands), and has the worker load the files again and start on them (`WorkerOptions.reload`, which `sanoma serve` gives; elsewhere the saved code runs once the instance starts again, which its output's `running` says).

  A change to the rules waits for `admin` here too: someone outside it is refused (`not_approver`), since nothing would review it. A save run again after its merge (a worker stopped under it) answers with that commit (`Source.saved`). With such a remote, Save opens the draft's change as saved at that head (`ChangeInput.save`, refused once the draft has moved on): in a round planned at that head, when the policy lets its drafter decide Publish (allowed, or held for a group where nobody else could), the run gives that Publish itself; otherwise Publish waits as asked.

- **Undo** reverts what a save of the person's chat put on `main` (`chat`, which the step checks: `SanomaClient.savedAs`): a draft of its own, `undo-<sha>` (`undoDraftOf`), with the revert committed on it (`Source.revert`), saved the same way.

## Review and publish

- **Review** starts the built-in `change` workflow on the draft, as the chat's person and titled as the chat (`SanomaClient.openChange({ id, title, page }, { startedBy })`; the run is `change:<id>`, and `change:<id>~2` for the draft's next change once that one has ended).

  Each round pushes the branch and opens its pull request into `main` (`sanoma.change.open`), runs `sanoma check` on the draft in the box of the person it is by (the app's `AppSteps.check`, so a worker without the app's steps fails it), with its Permissions grid, works out the facts the policy decides the merge on ([Policies](/policies/policies/)), asks the policy about the merge ahead, and sets the `sanoma` commit status on the head, linking the change's page (`sanoma.change.review`): pending, or failure while the checks fail or the policy denies.

  Then it asks one approval, **Publish the change**, covering `sanoma.change.merge`, of whom the policy's hold names, else of the person who drafted it. A deny waits instead, until something happens to the change.

- **The review.** The app's Changes section, in the bar when the repository has a remote, lists the changes. A change's page shows where it is, its branch at the head it last planned, its pull request, the files it edits by kind, the Permissions grid of `main` against the branch's, and Publish. The Inbox shows Publish as any approval, with the change linked.
- **New commits** on the draft start a new round at the new head. The agent tells the change after it commits, which withdraws Publish; a push to the branch on the host, told by its webhook, is read when Publish is decided, which then plans again instead of merging. An approval given in an earlier round lifts no hold on the new head.
- **Publish**, approved, squash-merges the pull request at the head the round planned, titled `<title> (#<number>)`, sets the status to success and deletes the branch (`sanoma.change.merge`); a head that moved meanwhile is planned again, and a merge the host refuses waits.

  A change to a collection's columns, opened with its plan (`ChangeInput.plan`), then brings the records along ([A column change](/workflows/collections/#a-column-change); Publish covers `sanoma.records.reshape` too), its counts, or why it failed (the merge stands), the report's and the state's `merged.reshaped`. A hold on the records that Publish does not lift (a pull request merged on the host, with no Publish, or a hold for someone other than Publish's approver) is such a failure, reported and never waited for: a change waiting there would hold back every deploy of `main`.

  **Try again** brings them along afterwards: `SanomaClient.reshapeChange(id, { startedBy })` starts the built-in `reshape` (`reshape:<id>`, `~<n>` after an ended one; started by nothing else) as the person who asks, over the plan the change carries (refused once the collection's columns are no longer what the change made them, as after a later change to them, since the plan would then move or delete their values: a renamed or removed field declared again, a rename's new name gone, a retyped field or a conversion's new column of another type, a link to another collection, or a conversion's free-form field no longer free-form; hiding or showing a column changes nothing of it), so the policy decides it as them, a hold waits for its approver in the Inbox, and the ledger records it under them; the change's view carries its latest one since the merge as `retry`, with what became of the records once it finished.

  Then the deploy: the checkout follows `main` (a fast-forward, skipped while another branch is checked out, the checkout has uncommitted changes or its `main` has commits the remote's lacks; when it moved, the worker loads the files again and starts on them, `WorkerOptions.reload`), apply runs on the declared hosts the lockfile binds (none before going live, whose apply makes them) as the run `<run>:deploy`, drift reads them back as `<run>:verify`, and the draft is closed.

  The page says Published, with the merge commit and what the deploy did. The change run outlives the deploy's restart of the worker on the merged code ([Versions](/hosting/versions/)).

- **Reject** on Publish closes the pull request and the change. A pull request merged on the host deploys as Publish does, and one closed there closes the change: the run checks either on the host before it believes it.

### Permission to publish

- **Who publishes.** A change to the rules (a policy, the root's or an app's, a people file, or a helper one imports) waits for `admin` whatever the policies say ([Policies](/policies/policies/)). A new company's `policies/changes.cedar` holds every other change for `admin` too; replace it with rules on the change's facts when another group should own part of the repository.
- **The Permissions line.** Under the Permissions grid the app says what the repository's host enforces on `main` (`SourceHost.enforcement`): a pull request, and the `sanoma` check. Where it enforces neither (a private repository on GitHub Free), a push to `main` that does not go through Sanoma is neither reviewed nor decided by the policy.

<a id="the-apps-actions" href="/reference/app-workflows/">Built-in app workflows and worker steps</a>

<a id="changes" href="/workflows/credentials/#authentication-compatibility">Authentication changes in earlier releases</a>
