---
title: "Import records from a CSV"
description: "Match CSV columns to collection fields and review which records will change before importing."
sidebar:
  order: 4
---

Export the sheet as a CSV with a header row. Open **Data**, choose the destination collection, and select **Import**.

1. **Upload** a CSV file by choosing or dropping it. The first row supplies column names. The preview respects RFC 4180 quoting, including commas, quotes, and line breaks inside cells.
2. **Match columns** to fields or choose **Skip**. Sanoma suggests fields with matching names, marks the key, and allows each field once. Removed fields are unavailable. To use a new field, add it to the collection declaration first.

   Resolve values the destination field cannot accept. The page shows the number of affected rows per value. Map a value to an enum option or a declared person (Sanoma suggests matches by name or email). With no declared people, it accepts an ID as written. You can omit a value to leave a new field empty or preserve an existing one. Choose **Fix first** to correct the data. The page lists any remaining invalid rows with their reasons before review.

3. **Review** looks up the sheet’s keys using your permissions and counts new, updated, unchanged, and invalid rows. The table shows the outcome for each row: **add**, **update** with the previous value, **unchanged**, or **fix first** with a reason.

4. Choose **Add n, update m** to start the import as yourself. The run opens and its output lists the rows it added, updated, or skipped. Policy applies to each save. A denied row appears as a problem and a held batch waits for a decision in the [Inbox](/using-the-app/approvals/).

For the batch rules and output fields, see [Importing a sheet](/workflows/collections/#importing-a-sheet).
