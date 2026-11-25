---
title: "Imports in a company repository"
description: "Look up the entry point to import in workflows, site routes, data files, and configuration."
sidebar:
  order: 11
---

| File                       | Imports                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sanoma.config.ts`         | Import `defineConfig` and any ledger store from `sanoma`. Import each connector from its package.                                                                                                                                                                                                                                                 |
| `workflows/*.ts`           | Import `defineWorkflow`, `defineOperation`, `mayDecide`, `errorCode`, `z`, `sanoma`, runtime operations, and types from `sanoma` as needed. The lint also accepts `zod` and `sanoma/workflows`. Import a declared collection from its `resources/data.ts` to list its operations in `uses`. See [workflow lint rules](/workflows/replay-safety/). |
| Site routes and components | Import routing and runtime APIs from `sanoma/site`, presentational components from `sanoma/ui`, and `createFileRoute` from `@tanstack/react-router`. See [site imports](/sites/imports/) for the full list, including `sanoma/claims`.                                                                                                            |
| Resource data files        | Import `sanoma` for people declarations and `secret` for secret references from `sanoma/resources`. Import vendor resource types from the connector’s `/resources` entry point.                                                                                                                                                                   |
| `resources/data.ts`        | Import only `collection` from `sanoma/data`. Each export declares one collection. The CLI loads this file in the root and in each app. See [Collections](/workflows/collections/).                                                                                                                                                                |
