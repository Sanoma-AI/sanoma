# packages/app/src/routes/connectors

The pages under `/connectors`: the list of the config's connectors and the page for one connector.

## Contents

| Path                           | What it is                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$vendor.tsx`](%24vendor.tsx) | `/connectors/:vendor`: one connector, its links, resource types and credentials' statuses, each operation's contract, phrases, mock and scenarios, and the workflows using it |
| [`index.tsx`](index.tsx)       | `/connectors`: every connector, with how many operations it has, workflows use it and variables it needs, linking to its page                                                 |
| [`route.tsx`](route.tsx)       | Layout for `/connectors`, with no component: sets the "Connectors" breadcrumb and page title                                                                                  |
