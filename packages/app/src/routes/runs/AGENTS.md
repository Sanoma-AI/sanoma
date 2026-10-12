# packages/app/src/routes/runs

Redirects from the old `/runs` URLs, kept so old links and bookmarks still work: runs now live on their workflow's page.

## Contents

| Path                     | What it is                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`$id.tsx`](%24id.tsx)   | `/runs/:id`: reads the run and redirects to `/workflows/:name/runs/:id`; not-found for a run that does not exist |
| [`index.tsx`](index.tsx) | `/runs`: redirects to `/workflows`                                                                               |
