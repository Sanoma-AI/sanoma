-- The wakeup row: one per database, made with the table (`sanoma_wakeup` in `src/db/company.ts`).
INSERT INTO "sanoma_wakeup" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
