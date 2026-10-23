# Persistent production storage and recovery

WaterCycle stores accounts, password hashes, enrollment, learning attempts, sessions, trips, correction/approval audits, and support tickets in PostgreSQL. Rule Offenders is derived from trip timestamps; preserving trips preserves violation history.

A GitHub push changes source code. A Vercel redeployment replaces application processes. Neither operation should replace the PostgreSQL resource or initialize classroom data.

## Safeguards in this release

- Hosted Production and Preview require a PostgreSQL URL with TLS. Local filesystem storage and demo mode are refused, including when a development flag is accidentally enabled.
- `WATERCYCLE_ENVIRONMENT` must match Vercel's `VERCEL_ENV`. Each database has a persisted environment/UUID marker. A preview process pointed at a bound production database fails before application writes.
- Managed application startup checks schema and identity using a read-only transaction. It does not create tables, migrate, seed, or bootstrap accounts. An empty/wrong database or incompatible ledger produces an error rather than a fresh classroom.
- Managed runtime roles must be non-owners, without schema creation, role-management, table ownership, truncate, or hard-delete privileges on classroom records. Session deletion remains available for logout and password changes. Existing teacher removal, archiving, and deactivation use updates and retain history.
- Migrations are an explicit maintenance operation, serialized with a PostgreSQL transaction advisory lock. Failed migrations roll back. Missing/future ledger versions and missing expected tables stop initialization instead of replaying historical migrations or recreating tables.
- Schema/environment-binding changes require a reviewed current version and a verified backup reference. Migration audit records retain the reference and before/after versions. The reference is an operator attestation; the app cannot verify a provider snapshot ID for you.
- Demo and browser-fixture scripts refuse hosted environments and managed connection URLs. Vercel's install/build commands contain no initialization, migration, seed, or reset hooks.
- One-time account provisioning is explicit. Existing credentials are never reset by startup or an initial-password variable. Normal sign-in uses the existing stored hashes and sessions.

These checks protect the application's deployment path. Database owners and provider administrators still have powerful access; keep those credentials outside the app, review future migrations, and maintain backups.

## 1. Create separate managed database resources

Use a managed PostgreSQL provider such as Neon, Supabase, or another Vercel-compatible service. Create:

1. A durable **production database**, retained across all production deployments.
2. A separate **preview database**, containing synthetic classroom data. Use separate credentials and a different UUID. Separate provider projects give stronger isolation than sharing one project. Protect production credentials from preview build jobs.

Do not connect both environments to the same database, choose a new production database on each deployment, recreate the production branch/resource, or run reset/seed commands as deployment hooks. Preview testing should not use an unsanitized copy of real student records. A restored production copy retains its production marker and is intentionally refused by Preview; use a newly initialized preview database for routine testing.

Generate one UUID for each environment in a trusted terminal:

```bash
node -e 'console.log(require("node:crypto").randomUUID())'
```

Keep each UUID stable. It is an installation identity, not a password. Never rebind an existing production database as Preview to get past an identity error. Confirm provider resource, database name, environment and UUID before maintenance. Runtime and direct maintenance URLs must point to the same database, even if their roles or pooled/direct hostnames differ.

### Existing installations and first-time cutover

If WaterCycle already uses managed PostgreSQL, retain that same provider resource and existing records; review/apply only pending schema versions and bind it once. If the records you want to keep currently exist only in Codespaces/PGlite, GitHub and Vercel do not upload `.local/data`. Preserve an offline copy and plan a separate, validated export/import into managed PostgreSQL before switching classroom use. That transfer must retain IDs, password hashes, relationships, learning state and migration history, and be tested on an isolated target first. This preparation does not transfer local records or require users to replace their accounts. Do not seed an empty production database as a substitute for transferring data you need to keep.

## 2. Configure Vercel environment scopes

In **Project → Settings → Environment Variables**, add separate values for each scope. When connecting a database integration, inspect its environment checkboxes so production credentials are not shared with Preview.

| Variable | Production scope | Preview scope |
| --- | --- | --- |
| `DATABASE_URL` | Pooled production PostgreSQL URL using the restricted runtime role | Pooled preview URL using the preview runtime role |
| `WATERCYCLE_ENVIRONMENT` | `production` | `preview` |
| `WATERCYCLE_DATABASE_ID` | Production's stable UUID | Preview's different stable UUID |
| `LOCAL_DATABASE` / `DEMO_MODE` | Unset or `false` | Unset or `false` |
| `LOCAL_DATABASE_PATH` | Unset | Unset |
| `MIGRATION_DATABASE_URL` | **Do not set in Vercel** | **Do not set in Vercel** |
| Initial account provisioning secret | Keep outside application deployments | Keep outside application deployments |

Vercel supplies `VERCEL` and `VERCEL_ENV`; do not override them. Do not prefix any connection string or secret with `NEXT_PUBLIC_`. Preserve provider TLS parameters; use `sslmode=verify-full` where supported, or the provider's `sslmode=require` URL. Disabling TLS is rejected. URLs must not override the connection host, schema/search path, or TLS settings with unrelated query options.

Use Node.js 24, the Next.js framework preset, the repository root, `npm ci` for installation, and `npm run build` for builds. The checked-in `vercel.json` sets these commands. No migration command belongs in Vercel's Build Command, install hooks, or application startup.

## 3. Review and migrate from a trusted operator terminal

Keep owner/direct credentials in a private password manager or ignored environment file, outside Vercel. The CLI loads `.env.local` if present; process environment values take precedence. For maintenance set:

- `MIGRATION_DATABASE_URL`: direct owner/migration connection for the target database, with TLS.
- `WATERCYCLE_ENVIRONMENT`: the target environment.
- `WATERCYCLE_DATABASE_ID`: that database's fixed UUID.
- Clear `LOCAL_DATABASE`, `DEMO_MODE`, and `LOCAL_DATABASE_PATH`. Codespaces sets local demo flags by default, so unset them in the operator terminal before using managed maintenance commands.

`DATABASE_URL` can remain unset for maintenance when `MIGRATION_DATABASE_URL` is provided. Never print connection strings, commit private files, or paste owner credentials into a public command example.

Inspect the database first:

```bash
npm run db:status
```

This command is read-only. It reports the configured environment/UUID, applied versions, pending versions, and whether identity binding exists. Review the new migration SQL in `src/lib/migrations.ts`. Existing published migration versions must stay unchanged. Future changes should use new versions and preserve old columns/data during deployment transitions. Schedule migrations during a quiet classroom period and stop writes when the change requires it.

Obtain and verify a backup as described below **before** running migrations. For a fresh empty database, take an initial provider snapshot or empty-database backup as the initialization reference too.

For an existing installation at version 4, this release uses:

```bash
npm run db:migrate -- --expected-version 4 --backup-reference YOUR_VERIFIED_SNAPSHOT_OR_BACKUP_ID
```

For a genuinely empty database, use `--expected-version 0`. Always use the current version shown by `db:status`; do not guess it or delete ledger entries. Version 5 adds database identity and migration audit tables. It does not change existing accounts, passwords, rosters, trip timestamps, reports, or learning progress. An unbound database at version 5 also requires a backup reference before first binding.

Run `db:status` again. All migrations should be applied and `bound` should be `true`. Repeating a fully applied migration command is a no-op; it does not seed or reset data. Keep the backup reference privately with the release record.

First-time account setup, if needed, is a separate authorized operator action using the existing private provisioning CLI after migration. Use a private initialization secret and remove it afterward. Running that CLI against an existing account preserves its password. The runtime never provisions accounts. Account identities and passwords should stay in your private operational records.

## 4. Create a restricted runtime database role

Create a dedicated LOGIN role in the provider console with a private generated password. It must not own the database/tables or inherit an owner role, and must have no superuser, `CREATEDB`, or `CREATEROLE` powers. Do not use the provider's owner URL as Vercel's `DATABASE_URL`.

After initial migration, have the owner apply the following grants in the target database. `watercycle_runtime` below is an example **database role**, unrelated to application sign-in accounts. Substitute the role you created. These grants change permissions, not classroom records.

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO watercycle_runtime;
GRANT SELECT, INSERT, UPDATE ON
  public.classrooms, public.users, public.sessions, public.questions,
  public.quizzes, public.visits, public.enrollments, public.rate_limits,
  public.student_status_events, public.break_corrections,
  public.problem_reports, public.problem_report_events
TO watercycle_runtime;
GRANT DELETE ON public.sessions TO watercycle_runtime;
GRANT SELECT ON
  public.watercycle_migrations, public.watercycle_database_identity,
  public.watercycle_migration_runs
TO watercycle_runtime;
```

Use a new role without prior broad grants; granting narrow permissions does not revoke privileges it already inherited. Do not grant `DELETE` or `TRUNCATE` on classroom/history tables, DDL powers, or write access to migration/identity tables. For future migrations that add tables, review and grant only the permissions the application requires. Avoid blanket grants to every future table.

Put that role's provider connection URL into the matching Vercel scope. Production and Preview need separate roles and credentials. For a managed development database outside Vercel use `WATERCYCLE_ENVIRONMENT=development` and its own UUID; do not use production credentials for development.

## 5. Backups before changes and recovery

Enable the provider's automated backups and point-in-time recovery **before classroom use**. Retention and recovery windows depend on the provider/plan. Choose a policy that covers your class schedule and acceptable data loss, check failed-backup alerts, and regularly restore into an isolated database to prove recovery works. Vercel deployments and GitHub commits do not back up database records.

Before each schema change, take an on-demand provider snapshot or a logical backup and record its time/reference. Keep encrypted backups in private storage outside the Vercel filesystem and repository, with access limited to authorized operators. Store older versions long enough to recover mistakes discovered after class.

The provided read-only backup command uses `pg_dump`. Install PostgreSQL client tools matching the server major version or a compatible newer version, set the direct maintenance connection privately, and choose a new file in a private directory:

```bash
mkdir -m 700 /PRIVATE_BACKUP_DIRECTORY
npm run db:backup -- --output /PRIVATE_BACKUP_DIRECTORY/watercycle-before-migration.dump
```

Use an actual private directory path. The command creates a custom-format backup with mode `0600`, refuses to overwrite an existing file, prints a SHA-256 checksum, and removes an incomplete file on failure. It does not run migrations. The checksum confirms file identity; only a successful restore drill proves recoverability. An isolated CI/local test file is not a backup of your real database.

For a restore drill or incident:

1. Pause production writes if recovering an incident. Preserve the current database/resource and take an incident snapshot. Select a recovery point and understand which later writes would be absent.
2. Restore into a **new empty database**, using provider restore/PITR or `pg_restore`. Do not use `--clean`, reset commands, or restore over the live database. Keep its connection details private. With private `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and TLS variables configured for the recovery target, a logical restore can use:

   ```bash
   pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname=watercycle_recovery /PRIVATE_BACKUP_DIRECTORY/watercycle-before-migration.dump
   ```

   Replace `watercycle_recovery` with the new empty target's database name; do not supply the live database name or put credentials in command arguments.
3. Check account/enrollment counts, password verification, trip/violation history, reports, learning state, migration ledger, and identity marker. Logical dumps omit owners/ACLs, so reapply reviewed runtime-role grants.
4. A recovered production database retains the production environment marker and UUID. For intentional production recovery use the existing production binding, verify the replacement resource, and update only the Production-scoped runtime connection.
5. Redeploy, check `/api/health`, and verify existing sign-ins, sessions, rosters, learning, trip returns and ticket access before resuming class. Keep the original resource and backup until recovery is accepted.

No destructive restore or database-reset command is exposed by the application. If the ledger or tables are missing, stop and restore/reconcile deliberately; never delete `.local/data` or recreate a managed database as a troubleshooting shortcut.

## 6. Deploy and verify persistence

Before first production deployment: review the target, verify a backup, apply pending migrations/binding, create the runtime role/grants, and configure the separate Vercel scopes. Then deploy.

`GET /api/health` returns only `{ "ok": true }` once runtime database checks succeed. It exposes no connection information, accounts, or database identifiers. A configuration/identity/schema error prevents successful readiness without modifying data.

For each release:

1. Test on the separate preview database first. Verify migrations against representative synthetic data and test backup recovery.
2. Review the production migration plan, obtain a verified backup, and apply only the pending versions through the operator command.
3. Deploy the new code using the unchanged production database resource and UUID. Reapply reviewed grants if new tables were added.
4. Confirm health and sign in with existing teacher/student accounts. Check class rosters, histories, Rule Offenders and problem reports, and confirm users do not need to register again.

Use a schema-compatible release for code rollback. Restoring an old database merely to roll back code can discard newer classroom writes. The app refuses a schema newer than it understands; prefer a forward fix and reviewed additive migrations over a destructive downgrade.

## Audit scope and reproducible checks

This preparation does not access, migrate, seed, bind, or back up an existing production database and does not configure a Vercel project. Actual provider resources, scoped Vercel settings, backup retention, and recovery access require the operator steps above. The safeguards are tested with a newly created disposable PostgreSQL server only.

```bash
npm test
npm run test:e2e
npm run build
npm run test:postgres
npm run typecheck
```

The GitHub verification workflow runs these checks on pull requests and pushes to `main`, with no production secrets and only disposable test storage. Configure branch protection to require its `verify` check before merging future updates.

The PostgreSQL test harness requires Docker and OpenSSL. It generates its own credentials and container, ignores real `DATABASE_URL` values, compares original rows across separate application processes and production Next.js server restarts, verifies role/environment/migration failures, and performs a real `pg_dump`/`pg_restore` round trip into a separate empty fixture database. It removes only its own test container, volumes, and temporary files. No production account or password is needed.
