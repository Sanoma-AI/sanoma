---
title: "Review a draft change"
description: "Review a draft’s checks, files, and permissions before publishing it."
sidebar:
  order: 5
---

Use the draft card in chat when you’re checking your own edits. To review a change someone has already submitted, open **Changes → Open** and select it.

## Review draft edits

1. Open the draft card and check the branch, changed files, and results of the checks. Sanoma offers the save and review controls after the draft has a commit and its checks pass.
2. If the company has a remote configured for review, choose **Review** to send the draft to another person. **Save to** can publish immediately if policy lets you decide.
3. Without a review remote, choose **Save to** only when you want the edits in the company. Check the card for the commit, who saved it, and any push error. A failed push leaves the local save in place. Use **Undo** to create a draft that reverts the save.

## Changes

1. Open the change from **Changes → Open** or from its approval in **Inbox**. Compare the file changes and the before-and-after cells in **Permissions**.
2. Check the policy decision and the checks for this revision. If you can decide, choose **Publish** to merge it or **Reject** to close it.
3. After publication, open the change to find its merge commit and deployment status. Find completed changes under **Done**.

For how Sanoma handles a draft that changes during review, see [Review and publish](/workflows/changes/#review-and-publish).
