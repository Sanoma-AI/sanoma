---
name: copywriting
description: Write and edit Sanoma README prose, product descriptions, UI copy and launch copy in a plain, concrete voice. Use for readability and tone changes while preserving technical meaning and product claims.
---

# Copywriting

Write as a person explaining Sanoma to someone who might use it. Give the reader enough detail to understand what it does and what they can do next.

## Start with the reader and the facts

Read the surrounding copy before editing. Identify the reader, what they came to learn and the action the passage should help them take. A developer choosing a framework needs different detail from someone approving a workflow run.

Use the root README for current product positioning and the relevant package documentation or code for behavior. Preserve the user's chosen audience and message. A voice edit is not a reason to reposition the product or turn planned features into current capabilities.

## Write plainly

- Name the person, thing and action. Replace phrases such as "work that needs a person waits for them" with the actual behavior: "The workflow waits for the marketing lead's approval."
- Lead with what Sanoma does. Explain a benefit through the feature that provides it. "Review and test a branch before publishing" tells the reader more than "the rigor of a software team."
- Use familiar words, but keep useful technical names. TypeScript, Postgres, a branch and an API are clear to a developer. Replacing them with vague phrases makes the copy harder to follow.
- Cut unsupported adjectives and slogans. "Highly customizable" needs an explanation of what someone can change. If the next sentence already supplies that explanation, the adjective can go.
- Keep one main idea in a sentence. Split a sentence when it changes subject or piles on conditions. Vary sentence length so the result still sounds like connected prose, not a sequence of clipped claims.
- Use "you" when the reader can take the action. Name an admin, developer or approver when permissions or responsibility matter. Do not imply that every reader can publish or approve.
- Use headings that tell readers what they will find. Use lists for steps or parallel features, not to turn every paragraph into a set of fragments.
- Avoid canned contrasts, rhetorical questions, inflated promises and tidy slogans that could describe any product. Do not add a recap that merely repeats the opening.

## Keep the meaning intact

Preserve commands, identifiers, links, version constraints and prerequisites unless correcting them is part of the task. Break dense instructions into steps or paragraphs without losing their conditions or order.

Keep qualifications next to the claim they limit. A fake service in a demo, a preview release or an admin-only action still needs to be named in readable copy. Do not turn "helps" into "guarantees," "can" into "always," or a default policy into a rule that cannot be changed.

For product introductions, put the explanation before implementation details. Link to detailed documentation when it is not needed for the reader's next decision. Operational instructions still need enough detail to execute correctly.

## Examples

These illustrate editing decisions, not phrases to reuse everywhere.

**Before:** "Sanoma is a framework for building highly customizable full-stack business apps: pages, data, workflows and the services they call, all TypeScript in your own repo."

**After:** "Sanoma is a TypeScript framework for building business apps. Your pages, data, workflows and service integrations live together in your own repo."

The second version names the framework and explains what belongs in the repo without asking adjectives to carry the message.

**Before:** "The workflow's page: the graph is drawn from the file, and picking a step says what it does and finds its lines under Code."

**After:** "Select a step to see what it does and find its source under Code."

The caption tells the reader what they can do; the preceding paragraph already explains where the graph comes from.

## Read the result in context

Read the edited passage from start to finish. Check that each sentence follows from the previous one, that pronouns have clear referents and that repeated explanations are earning their space. Compare the revision with the original for lost conditions and stronger claims. Check changed links and formatting as appropriate to the file.

Return the copy or make the requested edits. Keep any explanation of the writing choices brief; do not append a style audit unless asked.
