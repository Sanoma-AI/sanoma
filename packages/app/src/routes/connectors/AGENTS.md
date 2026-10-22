# packages/app/src/routes/connectors

The pages under `/connectors`: the list of the config's connectors and the page for one connector.

## Contents

| Path                           | What it is                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$vendor.tsx`](%24vendor.tsx) | `/connectors/:vendor`: one connector, its links, resource types and credentials (status, Set, Replace, Clear), each operation's contract, phrases and scenarios, and the workflows using it                                                               |
| [`index.tsx`](index.tsx)       | `/connectors`: Installed, every connector with how many operations it has, workflows use it and variables it needs, linking to its page; Available, the connector packages on npm not installed, each one's steps to add it in a sheet (`?add=<package>`) |
| [`route.tsx`](route.tsx)       | Layout for `/connectors`, with no component: sets the "Connectors" breadcrumb and page title                                                                                                                                                              |
