---
title: "Test a workflow with a scenario"
description: "Write a Gherkin scenario, run it against fake vendors, and inspect the result."
sidebar:
  order: 1
---

Create a `.feature` file under `scenarios/` in your company repository. Name one outcome you want to check. Each scenario name must be unique in the company and its apps. For a guided exercise using a scenario that already exists, [run your first workflow](/start/first-workflow/).

1. Use `Given` for any starting records, simulated failures, or person acting. A scenario run by `sanoma check` acts as the agent `scenarios` by default.
2. Use `When` to name the workflow and supply input that matches its schema. If the workflow will wait for an approval, include the decision the test runner should send.
3. Use `Then` to check an observable outcome, such as a call with specific fields or a run that succeeded. Choose the expression from the [step reference](/reference/scenario-steps/#scenario-step-reference) or the connector’s own steps.

## Test a launch announcement

This scenario seeds an existing post and a temporary failure. The assertions check what appeared at the fake vendors after the marketing lead approved the copy.

```gherkin
Feature: Announce a launch

  Scenario: Launch on time
    Given a post titled "Old news" exists
    And bluesky.post.create fails once
    When announce runs with
      """
      { "title": "Acme Pro", "launchAt": "2030-01-01T09:00:00Z" }
      """
    And "Review launch copy" is approved by marketing-lead with note "ship it"
    Then a post titled "Acme Pro" is created
    And post "post_0002" is published
    And "Acme Pro https://blog.example.test/acme-pro/" is posted to Bluesky
    And resend.broadcast.send was called with
      """
      { "id": "bc_0001" }
      """
    And the run succeeds
```

## Run the check

Run `npx sanoma check` from the company root. It checks the repository and runs the scenarios against fakes. If a feature fails to load, fix the reported file and line. If a step fails, compare its expected outcome with the recorded call or decision.

To inspect one run in the app, open its workflow, choose **New run → Sandbox**, select the scenario, and choose **Start sandbox run**. The **Ledger** tab shows the checks and calls. A held approval waits for a person when you start the run this way.

## Related documentation

- <a id="scenario-step-reference" href="/reference/scenario-steps/#scenario-step-reference">Gherkin steps</a>
- <a id="matching-steps-and-inputs" href="/reference/scenario-steps/#matching-steps-and-inputs">Input matching</a>
- <a id="resources-policy-and-actors" href="/reference/scenario-steps/#resources-policy-and-actors">Resource, policy, and actor steps</a>
- <a id="the-world" href="/reference/scenario-steps/#the-world">Seed a demo world</a>
- <a id="steps-a-connector-ships" href="/testing/conformance/#steps-a-connector-ships">Define connector-specific steps</a>
- <a id="sandbox-run-lifecycle" href="/testing/sandbox-runs/#sandbox-run-lifecycle">How sandbox runs work</a>
- <a id="compile-and-check-scenarios" href="/reference/scenario-api/#compile-and-check-scenarios">Scenario API</a>
- <a id="scenarios" href="/testing/workers/#run-scenarios-with-vitest">Run scenarios with Vitest</a>
