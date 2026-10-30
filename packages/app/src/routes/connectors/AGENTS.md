# packages/app/src/routes/connectors

The pages under `/connectors`: the list of the config's connectors and the page for one connector.

## Contents

| Path                         | What it is                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$vendor.tsx`]($vendor.tsx) | `/connectors/:vendor`: named connection cards and secure account actions, links, resources, operation contracts/scenarios and workflow dependencies                                                                                                       |
| [`index.tsx`](index.tsx)     | `/connectors`: Installed, every connector with how many operations it has, workflows use it and variables it needs, linking to its page; Available, the connector packages on npm not installed, each one's steps to add it in a sheet (`?add=<package>`) |
| [`route.tsx`](route.tsx)     | Layout for `/connectors`, with no component: sets the "Connectors" breadcrumb and page title                                                                                                                                                              |
