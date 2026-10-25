# Max Passes Allowed — isolated testing and migration 8

This update stays on `feature/teacher-portal-enhancements`. It does not authorize a merge, production migration or production deployment. Automatic Vercel Git deployments remain disabled for this branch.

## Teacher and student behavior

Open **Class Roster → View Class → Edit Class → Max Passes Allowed**, or set the value in **Create Class**. Both Primary Teachers and current co-teachers can save a whole number from **1 to 30**. Every existing class keeps its original value of **2**; new classes default to **2**. Editing other class settings preserves the saved limit.

The Overview statistics and pass spots, and the student's Classroom flow, use that class's saved limit. Spots wrap into rows on small screens. Reserved turns count toward the limit to prevent new requests from overtaking the queue. If there are more existing passes/reservations than the newly lowered limit, Overview continues to show those records so none disappear from teacher controls.

When the limit increases, eligible waiting students immediately receive reserved turns in FIFO order. When it decreases, existing outside students keep their passes and original departure times. Excess reserved turns keep their queue order, pause their response windows and cannot depart, even by directly calling the API. Only the oldest reservations that fit the remaining capacity may leave. A resumed reservation receives a fresh two-minute response window and the existing visible/sound/notification turn alert when enabled. Paused turns use a saved-place message and browser title. Returns, cancellations, schedule/enrollment restrictions and the existing quiz requirement continue to apply.

Classroom row locks serialize capacity edits, final quiz answers, departures, returns and queue promotion across PostgreSQL connections. A previously issued reservation is never permission to bypass the current limit. Historical trips and elapsed-duration calculations are unchanged.

## Migration 8 and its relationship to migration 7

Migration **8**, `maxPassesMigration` in `src/lib/migrations.ts`, reuses the existing `classrooms.capacity` integer column. It replaces `CHECK(capacity = 2)` with `CHECK(capacity BETWEEN 1 AND 30)`. The column remains NOT NULL with DEFAULT 2. There is no account, classroom-value, question, enrollment, trip, queue or timestamp backfill in migration 8, and no new table or runtime permission is required.

Migrations **1–7 are unchanged**. Migration 7 still adds Question Sets/co-teachers and preserves the previous question banks. From version 6, the reviewed release applies **7 then 8** in the existing migration transaction. From version 7, only **8** is pending. From version 8, setup is a no-op and preserves teacher-changed capacity. Never rerun historical SQL or edit migration ledger entries.

## Test in an isolated development checkout

1. Create a Codespace on `feature/teacher-portal-enhancements`, with no managed/production database secrets. Or use an independent local checkout and run `npm ci`.
2. Codespaces automatically run development setup. In a local checkout, or after updating a stopped existing development server, run:

   ```bash
   npm run dev:setup
   npm run dev
   ```

   Only the isolated local PGlite database is migrated automatically, through version 8. A version-7 local database is upgraded without resetting its data. The setup refuses managed URLs or production settings. Stop the server before setup so the database lock can be acquired.
3. Open port 3000. Sign in as development teacher `teachertest` / `1234567890`. Create two classes or edit the demo classes to different limits. Check limits 1, 2, 3 and 5, then refresh and reopen each class to verify persistence.
4. For a complete break/queue check, use multiple synthetic student accounts, approve their enrollments, and ensure each class has two eligible questions. Fill the limit, qualify another student, return one outside student, and confirm the oldest waiting student receives the next turn. Reduce the limit while students are outside; their original timers must continue. Increase it and check newly available reservations.
5. Add development teacher `mariamiller` as a co-teacher and sign in separately with development password `WaterCycle2026!`. Check that Edit Class can change the shared class limit while unrelated classes remain separate.

For a **separate synthetic managed PostgreSQL test database**, use its own preview binding and UUID and the existing [maintenance procedures](production-database.md). Verify `npm run db:status` privately. If its version is 7, take/verify a test backup, then explicitly run:

```bash
npm run db:migrate -- --expected-version 7 --backup-reference YOUR_VERIFIED_ISOLATED_TEST_BACKUP_ID
npm run db:status
npm run db:check
```

Use the isolated maintenance credentials only for migration, then the isolated restricted runtime connection for `db:check` and the app. Expect version 8, no pending migrations, and the same isolated database UUID. If version 6 is reported, review both pending migrations and use `--expected-version 6` instead, applying 7 and 8 together. Apply migration 7's additional table grants from the [Teacher Portal rollout guide](teacher-portal-enhancements.md#production-sequence--separate-approval-required) to the isolated runtime role. Migration 8 needs no additional grant. Codespaces intentionally refuse managed connections; use a trusted local operator environment for this optional managed test.

## Production remains a separate approved action

Do not run the commands above against Neon production as part of feature testing. After explicit approval, follow the existing backed-up [release sequence](teacher-portal-enhancements.md#production-sequence--separate-approval-required), using the actual current schema version (6 or 7), unchanged production identity and restricted runtime role. Pause old application writers during the schema/code cutover: the old release correctly refuses a newer migration ledger. Normal install, build and application startup never run managed migrations. Prefer forward fixes after migration rather than deleting ledger rows or rolling the schema backward.

## Automated verification

`npm test` covers defaults, bounds, independent classes, 1/2/3/5 capacity, FIFO, active-limit changes, paused reservations, co-teacher authorization, migration 7→8 data preservation and disk restart persistence. `npm run test:e2e` checks the exact login copy, class editor, responsive Overview spots, co-teacher edits and the real student quiz/queue/departure/return flow. `npm run test:postgres` creates its own TLS Docker PostgreSQL fixture, tests concurrent requests using the restricted runtime role, and verifies the saved limit across fresh application processes and production-like server restarts. TypeScript and production build checks also apply. No lint script is configured.
