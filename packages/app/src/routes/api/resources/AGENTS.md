# packages/app/src/routes/api/resources

The JSON API routes for declared resources and drift checks, mounted under `/api/resources`.

## Contents

| Path                   | What it is                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts) | `GET /api/resources`: the declared resources, their problems and the latest drift check           |
| [`drift.ts`](drift.ts) | `POST /api/resources/drift`: starts a drift check of the data files as they are now, as the actor |
