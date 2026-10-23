# Local database safety

Development uses a persistent PGlite database in `.local/data`. Vercel uses the managed PostgreSQL connection in `DATABASE_URL`; the local database and its demo data are never a production storage option.

PGlite supports one process per data directory. Stop the current server before starting another server or running the demo seed. For independent instances, set a distinct `LOCAL_DATABASE_PATH` for each instance. Browser tests already use a separate database.

WaterCycle places an exclusive `.watercycle.lock` file beside each local data directory. It records the owning process and, on Linux, its boot and process-start identity. A second live opener is refused. Locks from a dead process or a restored snapshot can be reclaimed automatically. Only the owner removes its lock when closing. SIGTERM and SIGINT initiate database close; let the server finish shutting down before restarting it.

If a local database cannot open, preserve the entire directory before attempting recovery. Never delete or reseed it automatically: it may contain student records. Restore a known-good backup, or choose a new `LOCAL_DATABASE_PATH` for a fresh demo. The demo seed requires `LOCAL_DATABASE=true` and refuses to run against `DATABASE_URL`.

Fresh Codespaces run `npm run dev:setup` automatically after dependency installation. This creates missing `teachertest` and Active `teststudent` accounts (development-only password `1234567890`), their `DEMO1` class, enrollment and question bank. Standalone setup, seeding, local diagnostics and local administrator provisioning load the same development environment files as Next.js. Neither managed database URLs nor hosted settings are allowed for demo setup; all managed connections are refused inside Codespaces.

Use `npm run dev:doctor` with the server stopped for a read-only check of local configuration, migrations, demo passwords, status and enrollment. Changed passwords and statuses are deliberately preserved. To get a completely new demo without destroying existing records, choose a new ignored `LOCAL_DATABASE_PATH`, then rerun setup.

`npm run dev:admin` is an opt-in, hidden-password prompt for a separate `watercycledev` Development Administrator. It replaces the administrator identity constraint only in that isolated PGlite database, transactionally, while retaining the single-administrator index and deletion/demotion/rename/disable protections. It refuses any existing managed identity binding or existing different administrator. This local policy is not part of the managed migration ledger and cannot run on managed PostgreSQL. Production retains its original administrator identity policy without a schema migration. Local application startup never consumes `ADMIN_INITIAL_PASSWORD` or provisions a privileged account automatically.
