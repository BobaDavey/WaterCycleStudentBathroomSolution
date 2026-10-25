# Teacher Portal enhancements — review and rollout

This feature branch targets `main` for review. Do not merge or migrate the production Neon database until the owner approves the release. No production connection is used by the development or test commands below.

The follow-up update adds [Max Passes Allowed and migration 8](max-passes-allowed.md), plus the requested shorter login description. Review migrations 7 and 8 together for this branch.

## Behavior

- The selected-class dropdown is on Overview, immediately left of Class Code. Selection persists across teacher pages. Overview approvals, counts, queue, code, and live flow are scoped to that class. Class Roster cards remain another way to open a class. The global header shows the class name without a dropdown.
- Questions can be unassigned or belong to multiple named Question Sets. The bank has Questions and Question Sets tabs, combined keyword/topic/set filters, an Unassigned filter, and newest/oldest/alphabetical sorting. Original question creation dates are unknown, so migration leaves them NULL; legacy ties sort by prompt. Creating and editing a question lets teachers choose multiple sets. Removing a set membership preserves the question; deleting a set preserves questions and historical quiz snapshots.
- Manage Active Sets is tied to the currently selected class. Eligibility is the distinct union of non-deleted, active questions in that class's active, non-deleted sets. Duplicate membership does not duplicate weighting. Empty or one-question banks keep the two-correct-answer rule and show teacher/student guidance. Teachers can deliberately save an empty selection. Existing outside students can still return and queues keep their order.
- Each original class receives an active **Existing question bank** set during migration, preserving its original eligible questions. New classes receive their normal starter biology bank in the same kind of active default set. A new independently created question can remain unassigned and will not appear in quizzes until assigned to an active set.
- Question Set activation or membership changes invalidate unfinished learning checks affected by that change; students start a fresh check. Visits, departed timestamps, and reservations are not reset. Ordinary edits to question content retain the previous immutable quiz-snapshot behavior. Shared content changes affect classes using that content; the UI calls this out.
- The Primary Teacher is the existing `classrooms.teacher_id`; there is no ownership transfer endpoint. Only that teacher can add or remove co-teachers. Membership is independent of insertion order and is stored once per class/teacher. Removal deactivates the membership and preserves the account, history and other classes.
- Co-teachers can manage classroom settings, student approvals, username enrollment, passwords through the existing account controls, questions, active sets, queues, trip returns/corrections, exports and Rule Offenders. Every mutation checks current account status and class access on the server. Membership changes serialize against classroom writes using the class lock. A removed teacher loses access on the next request; polling clears the removed class from their dashboard.
- A teacher's own question library can be reused across their classes. Co-teachers see questions originating in their shared class and sets created there or explicitly associated with it, plus their own library. They do not receive access to unrelated class rosters, histories or private question libraries. Content shared through a set is collaborative; editing or deleting that shared content affects its other uses. Deactivated set associations remain available for reactivation while class access remains authorized.
- Add Student now looks up a global username, shows the matched student's name and username, and requires confirmation. It enrolls that existing registered, non-suspended student as Approved, with teacher/timestamp and status audit. It never creates an account or changes a password. Existing active enrollments, including Pending/Deactivated ones, must be managed from their existing roster entry. A previously removed enrollment can be reactivated by confirmed teacher enrollment. Student class-code enrollment continues to create Pending enrollments.
- The Primary Teacher's account still controls the existing class-wide availability rule: disabling that primary account leaves its classes inactive. Co-teaching does not bypass that administrator security control.

## Schema and authorization

Migration **7** is `teacherEnhancementsMigration` in `src/lib/migrations.ts`; published versions 1–6 remain unchanged. It adds:

| Table/column | Purpose |
| --- | --- |
| `classroom_teachers` | Soft-revocable co-teacher memberships with a composite primary key, teacher index and role/primary-identity validation trigger. |
| `question_sets` | Named, optionally described sets with primary-library ownership, class provenance and soft deletion. |
| `question_set_questions` | Many-to-many question membership, using an active flag instead of deleting relationships. |
| `classroom_question_sets` | Independent per-class active set selection. |
| `questions.created_at` | Nullable legacy creation time; new questions use an absolute PostgreSQL timestamp. |

Foreign keys preserve referential integrity. Existing IDs, usernames, password hashes, class settings, time zones, questions, memberships, quiz snapshots and trip/report records remain. Backfill creates organization/membership rows, not replacement questions or user accounts. New tables require only `SELECT, INSERT, UPDATE` for the restricted runtime role; no hard-delete, truncate, ownership or DDL grant is needed.

Shared class checks are centralized in `src/lib/classroom-access.ts` and used by the domain queries and Rule Offenders scope. Teacher membership mutations have an additional Primary Teacher check. Session authentication, role checks, temporary-password gates, enrollment approval and account-wide suspension remain enforced.

## Test in isolation

1. Create a new Codespace on **this feature branch**, or use a separate local checkout with Node 24. Do not copy production environment files or production database credentials. Codespaces continue to refuse managed URLs.
2. The existing Codespaces setup installs dependencies, initializes its independent local PGlite database, applies migrations 7 and 8 locally and prepares development demo accounts. Outside Codespaces, run `npm ci`, then `npm run dev:setup` in a fresh development checkout without managed connection variables.
3. Run `npm run dev` and open port 3000. Development teacher: `teachertest` / `1234567890`. Development student: `teststudent` / `1234567890`.
4. On Overview, switch between the demo classes and check Class Code/statistics. Visit Question bank, create two sets, put a question in both, combine filters, and configure each class's active sets separately. Verify that two distinct active questions are available before requesting a break.
5. In Class Roster → View Class, look up `teststudent` in a class they have not joined and confirm the matched identity. Existing memberships correctly report that the student is already enrolled.
6. Add the existing synthetic teacher `mariamiller` as a co-teacher. In a separate private browser session sign in as `mariamiller` / `WaterCycle2026!`, open the shared class, and exercise classroom controls. The Primary Teacher can remove that membership; the co-teacher cannot change teacher membership through UI or API.

These credentials are local demo data only. This feature never seeds managed Production or Preview databases.

**Automatic Vercel Git deployments are disabled for this exact feature branch in `vercel.json`** (`git.deploymentEnabled`). Pushing the branch is for code/CI review and does not request a Vercel deployment. This leaves `main` deployment behavior unchanged. Keep the branch disabled until you have confirmed preview isolation; manual deploys must also use isolated configuration.

For a Vercel Preview, configure a separate synthetic managed database, its own stable UUID and `WATERCYCLE_ENVIRONMENT=preview`; apply reviewed migrations and restricted grants to that isolated target separately. Do not attach Production credentials or enable automatic preview branches cloned from classroom production data. The existing environment/identity checks refuse a deployment pointed at a database bound to a different environment. If your integration automatically injects Production connections or creates production-data preview clones, disable that automation before deploying this branch to Preview; test locally until isolation is configured.

Automated checks: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, then `npm run test:postgres`. There is no lint script configured in this repository. Browser tests use `.local/e2e-data`; PostgreSQL tests create their own TLS Docker server and credentials. Backend tests retain synthetic unregistered legacy-account fixtures to verify old records remain manageable; the public Add Student API no longer creates those accounts.

## Production sequence — separate approval required

1. Review/approve the PR and migrations 7 and 8. Validate the complete flow against a separate synthetic PostgreSQL environment first. Record the exact reviewed release commit. Keep the existing production resource, `main` database branch, connection role and `WATERCYCLE_DATABASE_ID` unchanged.
2. Schedule a quiet cutover and pause classroom writes. Stop older deployments/background callers from writing during the migration/code transition. The existing runtime refuses a migration ledger newer than its code understands, so older releases must not be used as rollback after version 8.
3. On the trusted operator Mac, use the exact reviewed release code with the existing private maintenance configuration (not an older checkout whose latest schema is still 6). Run `npm run db:status`. Expect current version **6** with pending **[7, 8]**. A database already at version 7 needs only **[8]**, using `--expected-version 7` instead in step 5. If the result differs, stop and review the actual plan; never edit/delete ledger entries.
4. Obtain and verify a **fresh production backup/recovery checkpoint** immediately before this release. Do not reuse an old empty-database backup taken before classroom records existed. Record its actual private reference and prove recovery access using the production guide.
5. Only after approval, run the following locally with the direct maintenance connection and actual verified backup reference:

   ```bash
   npm run db:migrate -- --expected-version 6 --backup-reference YOUR_VERIFIED_PRE_RELEASE_BACKUP_ID
   npm run db:status
   ```

   Expect version **8**, pending **[]**, and `bound: true` with the same UUID. Startup/build commands still never perform managed migrations or bootstrap accounts.
6. Have the database owner apply these additional grants to the **existing** restricted runtime role in that same production database:

   ```sql
   GRANT SELECT, INSERT, UPDATE ON
     public.classroom_teachers, public.question_sets,
     public.question_set_questions, public.classroom_question_sets
   TO watercycle_runtime;
   ```

   Keep all previous grants and all existing role restrictions. No password rotation or ownership change is needed. Run `npm run db:check` locally using the restricted connection.
7. Merge/deploy the reviewed release only after approval. Preserve the existing protected runtime connection and Production scope. Keep owner/migration credentials outside Vercel. Migrations 7 and 8 contain no environment-variable or integration changes. Migration 8 requires no grants beyond the existing table permissions.
8. Check `/api/health`, anonymous `/api/auth/me`, existing account logins, class codes, default active sets, pending approvals, a complete student break, co-teacher access/revocation, Rule Offenders and reports. Confirm record counts and sample existing question content/history against the pre-release verification. Resume classroom use after acceptance.

A migration failure rolls back the transaction. Investigate the safe error code and retain the existing database. Do not reset, reseed, drop tables or force the migration ledger backward. After a successful migration, prefer a forward fix; incident recovery must follow the separate backup/restore procedure and preserve subsequent classroom writes.

## Validation

Passed locally with isolated data: TypeScript checks, production build, all **135 backend tests**, all **28 browser tests**, and all **14 TLS PostgreSQL persistence/recovery tests**. The capacity follow-up also has focused browser coverage for pausing/resuming turn alerts and direct-API departure enforcement. A strengthened disk-restart/seed-repeat check preserves active trips, paused reservations, teacher-changed capacity, unassigned questions and inactive sets. Tests cover limits 1, 2, 3 and 5, co-teacher changes, FIFO and concurrent requests. Baseline schema and migration SQL 1–7 were compared with the previous feature commit and are unchanged. No production database was accessed or migrated; no production deployment was performed. These checks use isolated local/Docker environments, not a real GitHub Codespace. No lint command is configured.

## Changed files

The versioned migrations are **7 and 8**, defined in `src/lib/migrations.ts`. The complete review file list is:

- `README.md`
- `docs/production-database.md`
- `docs/teacher-portal-enhancements.md`
- `docs/max-passes-allowed.md`
- `scripts/seed.ts`
- `src/app/api/[...path]/route.ts`
- `src/app/page.tsx`
- `src/components/question-bank.tsx`
- `src/components/student-dashboard.tsx`
- `src/components/student-dashboard.module.css`
- `src/components/teacher-dashboard.module.css`
- `src/components/teacher-dashboard.tsx`
- `src/lib/classroom-access.ts`
- `src/lib/class-capacity.ts`
- `src/lib/contracts.ts`
- `src/lib/domain.ts`
- `src/lib/managed-database.ts`
- `src/lib/migrations.ts`
- `src/lib/question-sets.ts`
- `src/lib/rule-offenders.ts`
- `tests/e2e/classroom.spec.ts`
- `tests/e2e/class-capacity.spec.ts`
- `tests/e2e/enrollment-schedules.spec.ts`
- `tests/e2e/portals.spec.ts`
- `tests/e2e/teacher-enhancements.spec.ts`
- `tests/e2e/time-zones.spec.ts`
- `tests/migrations.test.ts`
- `tests/class-capacity.test.ts`
- `tests/multiclass.test.ts`
- `tests/postgres/persistence.test.ts`
- `tests/postgres/deployment-worker.ts`
- `tests/student-fixtures.ts`
- `tests/teacher-demo-preservation.test.ts`
- `tests/teacher-enhancements.test.ts`
- `vercel.json`
