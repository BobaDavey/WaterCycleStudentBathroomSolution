# Persistent production storage and recovery

For the Teacher Portal feature release, follow the [migrations 7–8 review and cutover sequence](teacher-portal-enhancements.md#production-sequence--separate-approval-required). Existing version-6 production databases need reviewed migrations 7–8 and migration 7’s additional restricted-role grants (version-7 databases need only migration 8); do not repeat fresh-database initialization.

WaterCycle stores accounts, password hashes, enrollment, learning attempts, sessions, trips, correction/approval audits, and support tickets in PostgreSQL. Rule Offenders is derived from trip timestamps; preserving trips preserves violation history.

A GitHub push changes source code. A Vercel redeployment replaces application processes. Neither operation should replace the PostgreSQL resource or initialize classroom data.

## Neon and Vercel first deployment walkthrough

Use this walkthrough when Vercel is Ready but `/api/auth/me` fails after connecting a new Neon database. The integration supplies a URL; it does **not** install WaterCycle's tables, bind the database identity, or create a restricted application role. A Ready build does not prove database readiness. An empty schema fails the startup check; after migration, an owner connection is also intentionally refused. The old log containing only `error` discarded PostgreSQL's reason and cannot establish the exact original driver failure.

These steps preserve the existing database resource and its records. They never reset, seed, truncate or delete classroom data. Use a trusted personal computer outside GitHub Codespaces. Codespaces intentionally refuse production maintenance connections. Keep connection strings and passwords in your password manager/private environment file, never in chat, GitHub, screenshots or Vercel build commands. Console labels may vary slightly by provider version.

### Step 1: Get the current code on your computer

Install [Node.js 24 LTS](https://nodejs.org/) and [Git](https://git-scm.com/downloads) if necessary. Open a terminal on your own computer. For a new checkout:

```bash
git clone https://github.com/BobaDavey/WaterCycleStudentBathroomSolution.git
cd WaterCycleStudentBathroomSolution
npm ci
```

For an existing checkout, save any unrelated local work first, then use `git pull --ff-only origin main` and `npm ci`. Do not use a reset command. The install command does not initialize a managed database.

### Step 2: Identify the exact production database and identity

In **Vercel → your WaterCycle project → Settings → Environment Variables**, find the **Production** value of `WATERCYCLE_DATABASE_ID`. Keep this same UUID; do not generate a replacement. Confirm `WATERCYCLE_ENVIRONMENT` is `production`.

Open the connected Neon resource from **Vercel → Storage → your Neon database → Open/Manage in Neon**, or sign in at [Neon Console](https://console.neon.tech/) and open that same project. Select the branch/database that the Production connection uses. Do not assume that an unrelated Neon project or preview branch contains your production records.

In Neon click **Connect**, select that branch, database and the existing **owner** role, and turn **Connection pooling OFF** to obtain the **direct maintenance** URL. Copy it privately for the next step. Do not put this owner URL into the Vercel runtime configuration.

### Step 3: Create a private maintenance configuration

In your local checkout, create `.env.local` with your editor. This file is ignored by Git. Replace each angle-bracket placeholder privately; keep the double quotes around the connection string. Use this minimal configuration in a fresh operator checkout:

```dotenv
NODE_ENV=production
WATERCYCLE_ENVIRONMENT=production
WATERCYCLE_DATABASE_ID=<the existing Production UUID from Vercel>
MIGRATION_DATABASE_URL="<the direct owner connection copied from Neon>"
DATABASE_URL=
LOCAL_DATABASE=false
DEMO_MODE=false
LOCAL_DATABASE_PATH=
```

Keep the file accessible only to your own OS account. Do not enable Codespaces or Vercel flags in this local terminal. Values already exported in your terminal take precedence over `.env.local`; use a fresh terminal without earlier database settings if unsure.

Run the read-only inspection:

```bash
npm run db:status
```

The result includes `currentVersion`, `latestVersion`, `pending`, and `bound`. For a genuinely new empty database, expect `currentVersion: 0`, pending versions 1–8, and `bound: false`. This feature release's latest version is 8. If you see an identity mismatch, incompatible history, or missing expected tables, **stop** and follow the recovery section; do not delete the ledger, recreate tables, or change the UUID to force the check to pass.

### Step 4: Verify a backup before initialization or migration

Even an empty database needs a verified initial backup reference. In Neon open **Branches → Create branch** (sometimes **New branch**), choose the exact production branch as the parent at the **current** point in time, and give the backup branch a descriptive name. Wait for it to finish. Open **SQL Editor**, select the **backup** branch and database, and verify its table list/counts match the source. Record the actual backup branch ID and creation time privately. Retain it until the release is accepted. This is a restricted recovery copy; never connect a test application or Vercel Preview to a backup containing real classroom records.

Use this procedure only when your plan supports a retained branch/recovery checkpoint and you have verified that it is accessible. Alternatively, use the `db:backup` and isolated restore procedure in section 5 below with compatible PostgreSQL client tools. Do not invent a backup reference or proceed without recoverability.

### Step 5: Apply only the reviewed pending migrations

Review the pending SQL in `src/lib/migrations.ts`. If Step 3 showed **currentVersion 0**, run this command after replacing the backup placeholder with the actual verified reference:

```bash
npm run db:migrate -- --expected-version 0 --backup-reference YOUR_VERIFIED_NEON_BACKUP_BRANCH_ID
npm run db:status
```

If `currentVersion` was another number, use **that exact number** instead of 0. If `pending` is empty and `bound` is true, skip migration. Successful initialization shows `pending: []`, `bound: true`, and `currentVersion: 8`. Migrations use a transaction and preserve existing records. Do not add this command to Vercel's install, build or startup commands.

### Step 6: Create a dedicated restricted runtime role

In Neon open **SQL Editor**. Select the **production branch and database**, using the existing **owner** role. A database role is different from a WaterCycle teacher or Developer sign-in account.

First check whether the proposed runtime role already exists:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles WHERE rolname = 'watercycle_runtime';
```

If there are no rows, generate a strong **new runtime-database password** in your private password manager and create the role below. Replace the placeholder **only in Neon's private SQL editor**, using a generated password without a single quote, and never save the completed query in this repository or share it. This is not your WaterCycle Developer password.

```sql
CREATE ROLE watercycle_runtime LOGIN
  PASSWORD 'REPLACE_WITH_A_NEW_PRIVATE_RUNTIME_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
```

If the role already exists, do not recreate it or reset its password. Review its existing grants/memberships first; use the intended restricted role and its stored private credentials. A role created through a provider UI may inherit elevated provider roles, so do not assume every newly created provider role is restricted. Do not grant owner or `neon_superuser` membership.

Next, run the **complete grant SQL in section 4 below** in this same production database. It grants the needed application access, including `student_username_counters`, and read-only migration metadata access. It does not change accounts, passwords, classroom data or history. If database `CONNECT` has been revoked from `PUBLIC`, the owner must also grant `CONNECT` on this existing database to the runtime role. Never use `GRANT ALL`, ownership, schema creation, table deletion or truncate grants to bypass an error.

### Step 7: Test the runtime credentials before deploying

In Neon **Connect**, keep the same production branch/database and select the `watercycle_runtime` role. Copy its provider-generated connection string with TLS (pooling may be enabled for the Vercel runtime). If a manually created SQL role is not listed, use the same connection details with the runtime role/password entered privately; use URL-encoded credentials rather than unescaped special characters. Keep the direct owner URL for maintenance only.

In your **private local** `.env.local`, set `DATABASE_URL` to that runtime URL. Leave the environment and UUID unchanged, and run:

```bash
npm run db:check
```

It must report `ok: true`. This command is read-only and checks connectivity, applied migrations, database identity, the non-owner role and required grants, and the anonymous authentication-state queries. It does not migrate, seed, create accounts or print secrets. A failure prints a safe category/code and a remediation hint; use the table below rather than weakening the protections.

### Step 8: Configure Vercel Production and redeploy

Go to **Vercel → WaterCycle → Settings → Environment Variables**. Edit the **Production-scoped** `DATABASE_URL` to the **runtime-role** URL from Step 7. If the integration manages that variable, update its role/connection configuration through the integration settings; verify the effective Production value is the restricted role's connection. Do not delete the database resource or share its owner connection as a workaround.

Keep `WATERCYCLE_ENVIRONMENT=production` and the **same** `WATERCYCLE_DATABASE_ID`. Remove `MIGRATION_DATABASE_URL`, `ADMIN_INITIAL_PASSWORD`, `DEV_ADMIN_INITIAL_PASSWORD` and `LOCAL_DATABASE_PATH` from Vercel; leave `LOCAL_DATABASE` and `DEMO_MODE` unset or false. Preview must use a separate database/UUID/credentials. Do not override Vercel's own `VERCEL` or `VERCEL_ENV` variables.

Keep **Settings → Build and Deployment** at `npm ci` / `npm run build`. Then open **Deployments → latest Production deployment → ⋯ → Redeploy** so the saved variables are used.

### Step 9: Verify the live site without logging in

Open `https://YOUR_SITE/api/health`: expect HTTP 200 and `{"ok":true}`. Open `https://YOUR_SITE/api/auth/me` in a private/incognito browser window: expect HTTP 200 with `"user":null` (and no credentials or classroom data). The home page should now show sign-in. If it still fails, open **Vercel → your deployment → Logs/Runtime Logs**, filter `/api/auth/me`, and find `WaterCycle request failed:`. Share only its `code`, `category`, `stage` and `requestId` if you need help. Do not share raw connection strings, passwords, cookies or classroom records.

Existing WaterCycle accounts are retained by migrations and should sign in normally. A genuinely empty Neon database does not contain accounts from an independent Codespace database. Do not seed public demos in Production or register replacements for records that need to be imported. If this is an intentionally new installation with no privileged account (`adminProvisioned: false`), set `ADMIN_INITIAL_PASSWORD` privately **only in the operator's local environment**, run `npm run admin:bootstrap`, verify sign-in, then remove that one-time secret. The bootstrap preserves an already existing privileged account and its password. Create teacher accounts through the existing portal. Importing needed Codespaces records is a separate, validated transfer; this walkthrough does not overwrite them or move them automatically.

### Safe diagnostic codes

| Server log code | Meaning and safe next action |
| --- | --- |
| `DB_MIGRATIONS_REQUIRED` | Missing setup or a missing table/column (`42P01` / `42703`). Inspect `db:status`; back up and apply only reviewed pending migrations. If the ledger already says complete, stop and reconcile/restore instead of replaying migrations. |
| `DB_SCHEMA_INCOMPATIBLE` | Inconsistent/future ledger or missing expected tables. Preserve the database and reconcile/recover deliberately. |
| `DB_RUNTIME_ROLE_UNSAFE` | The connection uses an owner or elevated role. Use the restricted runtime role; do not disable the check. |
| `DB_PERMISSIONS` | Missing required grants, forbidden metadata writes, PostgreSQL `42501`, or a read-only target (`25006`). Review section 4 and the intended writable production endpoint. |
| `DB_AUTHENTICATION` | PostgreSQL rejected the **database** login (`28P01` / `28000`). Correct the private runtime connection credentials. This is different from an incorrect WaterCycle username/password, which returns HTTP 401. |
| `DB_CONNECTION` / `DB_TLS` / `DB_PROTOCOL` | Networking/provider availability/limits, certificate verification, or pooler/protocol failure. Check the private provider connection; do not disable TLS. Use a direct connection for maintenance. |
| `DB_CONFIGURATION` / `DB_DATABASE_NOT_FOUND` | Missing/mismatched environment configuration or nonexistent target database. Verify Vercel scope and private connection settings without replacing the production resource. |
| `DB_IDENTITY_MISMATCH` | Wrong resource, deployment environment or UUID. Restore the intended connection/binding; do not rebind production as Preview. |
| `DB_QUERY_FAILED` | An allowlisted SQLSTATE identifies a query, constraint or database-internal failure. Keep the reference/code for investigation; raw SQL and driver messages remain private. This returns HTTP 500. |

Infrastructure failures return HTTP 503 with a generic public message and request reference, without exposing the detailed category to visitors. Unexpected application failures remain HTTP 500. Normal unauthenticated `/api/auth/me` returns HTTP 200 with `user: null`; protected endpoints and incorrect app credentials return HTTP 401. Logs contain only allowlisted codes, fixed hints, endpoint templates and stages, never driver messages, SQL, URLs, passwords or student details. A production build checks environment configuration but intentionally does not connect or initialize the database.

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
- Clear `LOCAL_DATABASE`, `DEMO_MODE`, and `LOCAL_DATABASE_PATH` in a trusted operator workstation or private maintenance job outside Codespaces. Codespaces deliberately refuse all managed database connections, including maintenance commands; keep production connection secrets out of Codespaces.

`DATABASE_URL` can remain unset for maintenance when `MIGRATION_DATABASE_URL` is provided. Never print connection strings, commit private files, or paste owner credentials into a public command example.

Inspect the database first:

```bash
npm run db:status
```

This command is read-only. It reports the configured environment/UUID, applied versions, pending versions, and whether identity binding exists. Review the new migration SQL in `src/lib/migrations.ts`. Existing published migration versions must stay unchanged. Future changes should use new versions and preserve old columns/data during deployment transitions. Schedule migrations during a quiet classroom period and stop writes when the change requires it.

Obtain and verify a backup as described below **before** running migrations. For a fresh empty database, take an initial provider snapshot or empty-database backup as the initialization reference too.

For an existing installation at version 5, this release uses:

```bash
npm run db:migrate -- --expected-version 5 --backup-reference YOUR_VERIFIED_SNAPSHOT_OR_BACKUP_ID
```

For a genuinely empty database, use `--expected-version 0`. Always use the current version shown by `db:status`; do not guess it or delete ledger entries. Version 5 adds database identity and migration audit tables. Version 6 adds class-specific enrollment permissions, schedules without arbitrary defaults, cancellation explanations, a separate account suspension flag, and atomic username counters; existing usernames, hashes, memberships, approvals, and history are retained. It does not change existing accounts, passwords, rosters, trip timestamps, reports, or learning progress. An unbound database at version 5 also requires a backup reference before first binding.

Run `db:status` again. All migrations should be applied and `bound` should be `true`. Repeating a fully applied migration command is a no-op; it does not seed or reset data. Keep the backup reference privately with the release record.

First-time account setup, if needed, is a separate authorized operator action using the existing private provisioning CLI after migration. Use a private initialization secret and remove it afterward. Running that CLI against an existing account preserves its password. The runtime never provisions accounts. Account identities and passwords should stay in your private operational records.

### Version 6 classroom/enrollment rollout

Pause classroom writes during the schema/code cutover; older application versions assume one active membership and must not keep writing once multiple enrollments become available. After a verified backup and reviewed migration, grant the restricted runtime role `SELECT, INSERT, UPDATE ON public.student_username_counters` (in addition to its existing grants), deploy this release, verify health and existing logins, then set schedules for existing classes. Do not redeploy the old single-class code against new multiple memberships.

Existing classes intentionally retain NULL start/end times until their owning teacher configures them. New requests are blocked, but outside students can still return and timers/correction histories remain intact. Existing enabled/approval fields are retained; enrollment approvals are copied reliably from them. Previously disabled students also retain an account-wide suspension for conservative security. A class teacher may reactivate an enrollment but cannot clear an account-wide restriction; only an authorized operator should review and clear such a suspension in a separately approved maintenance action. The migration does not change passwords, usernames, accounts, historical timestamps, or report contents.

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
  public.problem_reports, public.problem_report_events, public.student_username_counters,
  public.classroom_teachers, public.question_sets,
  public.question_set_questions, public.classroom_question_sets
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
