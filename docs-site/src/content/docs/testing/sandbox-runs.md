---
title: "How sandbox runs work"
description: "Understand what a sandbox shares with a live run, how its fakes are seeded, and when checks settle."
sidebar:
  order: 5
---

A sandbox run answers a question about your workflow: given these inputs, vendor state, and company policy, what would the workflow do? It runs the same workflow body and evaluates the same policy as a live run. Each vendor call goes to a fake owned by this run.

For example, in the starter company’s [first workflow](/start/first-workflow/), the ledger shows a save to the Outbound collection. The record exists in that run’s fake collection. Another run starts with its own records.

## Sandbox run lifecycle

The worker parses the input and seeds the fakes from the scenario’s `Given` steps. A company operation runs its real body against those fakes. Two scenarios can run on the same queue without seeing each other’s vendor state. An approval can still hold a call. In the app a person decides it, and an automated scenario runner can send the decision specified by the feature.

As the run waits for approval or ends, Cucumber checks each `Then` against the ledger. A waiting run can still make more calls, so a check can remain unsettled. Checks report what happened and never determine which step the workflow takes next. A sleep records its deadline and the sandbox continues immediately.

The fakes live in worker memory. After a worker restart, a checkpoint can recover the ledger but cannot reconstruct the vendor state that produced it. Start the scenario again to get fresh fakes and a new run.

For the reported errors, records, and client arguments, see [Sandbox runs in the client](/reference/scenario-api/#sandbox-runs-in-the-client).
