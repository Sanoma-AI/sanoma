---
title: "Edit collection records"
description: "Edit records in the grid, review a bulk change, or inspect a record’s history."
sidebar:
  order: 6
---

Open **Data**, choose a collection, and select the cell you want to edit. To bring in a file, [import a CSV](/using-the-app/import-records/).

## Data

The collection list shows each collection’s key, fields, declaration file, and which workflows and sites use it. If several apps declare collections, use the folder tabs to narrow the list. **Yours** shows collections declared at the repository root.

### Edit a collection

Select a cell and type, or press **Enter** to edit. Press **Enter** to save. **Esc** cancels the edit. **Tab** saves and moves right. Use the record form for free-form values. Select a linked key to open the related record. A struck-through key means the record is missing.

The grid saves individual edits in order. Choose **Undo** on the save notification to restore the previous value.

| If the save…                | What you’ll see                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Needs approval              | A hollow dot and **waits for approval**. The grid shows the stored value until the run finishes.        |
| Is denied                   | The reason for the denial. The cell returns to its stored value.                                        |
| Conflicts with another edit | An orange cell with your edit and the current value beneath it. Choose **Keep theirs** or **Use mine**. |

### Paste and review a range

1. Select the top-left cell and paste from a spreadsheet with **Cmd/Ctrl+V**. Rows beyond the end become new records. Include their keys in the paste or enter them before saving.
2. Choose **Review** to compare each field’s previous and proposed values. Red cells need attention. Green rows are new, and struck-through rows will be deleted.
3. Choose **Save as one change** to submit the batch, or **Save n now** to submit only the ready records. Remaining edits stay staged. **Discard** clears the staged change.

To fill a range, select it with **Shift+arrow** or drag across it. Type or paste one value to fill the selection, or drag the fill handle down to repeat values. **Delete** clears the selected cells. **Including a key cell deletes the record.** **Shift+Enter** adds a row. **Cmd/Ctrl+Z** reverses the last staged step.

While changes are staged, finish or discard them before sorting, filtering, opening the record form, following a key, or leaving the page. Sanoma rereads each record before submitting. Resolve any conflicts cell by cell.

The submitted batch saves as one operation. Policy checks each record. A denial removes the refused records from the proposal and leaves the others staged. A hold links to the waiting run. Other failures leave the batch staged and save nothing.

To copy the selection as tab-separated text, press **Cmd/Ctrl+C**. **Export CSV** downloads the grid as displayed, including free-form fields as JSON.

### Column width and sort order

Drag the edge of a heading to resize a column. The browser remembers its width for that collection. Select a sortable heading to cycle through ascending, descending, and key order. Free-form fields cannot be sorted.

Filter by key prefix or enum value above the grid. **Fields** controls which columns you see. **Show at most** defaults to 100 records and accepts up to 1,000.

### Change a column

Open a column’s heading menu to rename it, change its type, or hide it. The key column has no menu. Choose **+** after the last column to add a field. For a free-form field, **Convert to column** moves a selected key into its own column.

| Choice                  | Effect                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hide for me**         | Hides the field in your view.                                                                                                               |
| **Remove for everyone** | Hides the field from all grids and forms. Values stay stored. Use **Fields → Hidden columns → Show again** to restore it.                   |
| **Remove for good…**    | Removes the declaration and deletes its values. Check the affected record count before confirming. If the count changes, Sanoma asks again. |

Check **What will happen** before proposing a conversion. When some values won’t convert, choose **Leave these n empty** to clear them or **Keep them as they are** to flag them as **needs fixing**. For a link, the value must match a key in the destination table. An existing record with a broken link is marked **needs fixing**. Choose a valid key or clear the link before saving.

### Review a schema change

Start column changes from the local app. **Review the change** checks the plan against all records and edits the declaration in `resources/data.ts`. With a review remote, the change goes for review. Without one, Sanoma commits it locally and updates the records.

Check the proposed rename, conversion, or deletion. Choose **Approve and apply** to accept it or **Send back** to request a different conversion choice. After publication, **The records** reports how many values changed.

If the declaration was published but the records couldn’t be updated, open the linked run. **Try again** reapplies the plan with your permissions and can require approval. Finish a pending rename or removal before reusing its column name. A later schema change can make the original plan inapplicable. **Copy the details** gathers the change and run IDs for troubleshooting. See [how column changes apply](/workflows/collections/#a-column-change).

### Edit a record and inspect its history

Select a record’s key or press **Space** on its row to open the form. Choose **Add record** to create one. An existing record’s key is fixed. Choose **Save** to submit your edits. If someone else changed the record, the form refuses the save. **Delete** asks for confirmation. Field errors appear beneath the input. A held save or delete links to its approval run.

**History · from the ledger** shows saves and deletes, newest first. Each entry gives the actor, time, and fields changed. Workflow entries link to the run. Only readers with permission to get the record can see its history. Sanoma examines the latest 500 calls for that record, including reads, and tells you when older changes may be missing.

![The Outbound grid sorted by stage, with one lead’s record open beside it](../../../assets/start/app-data-grid.png)
