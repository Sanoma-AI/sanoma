---
title: "Run your first workflow"
description: "Run the starter company’s Record a lead scenario and inspect the saved lead in its ledger."
prev:
  link: /start/setup/
  label: Set up a company
sidebar:
  order: 4
---

You’ll record a lead for Acme in a sandbox and check how Sanoma saved it. This exercise uses the **Record a lead** workflow and the **A lead is recorded** scenario from the starter company.

## Open the starter company

Open the local address printed by `sanoma init`. If you stopped the app, run `npx sanoma` in the starter repository and open the address it prints. If you installed Sanoma in an existing repo without the sample files, [create a starter company in a separate empty directory](/start/start-a-company/) for this exercise.

Select **Workflows** and search for `record-lead`. Open **Record a lead**. Its **Code** tab shows the function that saves a record to the Outbound collection.

## Start the sandbox run

1. Choose **New run → Sandbox**. Select **A lead is recorded**.
2. Check the two input fields. The company is **Acme** and the contact is **Sam Jones**. The scenario supplies these values, so the fields are read-only.
3. Choose **Start sandbox run**. Sanoma opens the run page with a sandbox badge. This run uses its own collection data and leaves the company’s Outbound board unchanged.

## Check the saved lead

Open **Ledger**. Under **Checks**, look for three results. The call to `data.outbound.save` included Acme, Sam Jones, and the stage `researched`. The step **Record the lead** ran once. The run succeeded.

Select the save operation in the graph to inspect its recorded input and output. You can return to this same run from the workflow’s **Runs** tab.

To change what the exercise checks, open `scenarios/record-lead/record.feature` in the starter repository. Compare its three assertions with the results you just saw. To write a workflow of your own, [use an installed connector in a workflow](/workflows/writing-workflows/).
