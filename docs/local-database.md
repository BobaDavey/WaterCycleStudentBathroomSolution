# Local database safety

Development uses a persistent PGlite database in `.local/data`. Vercel uses the managed PostgreSQL connection in `DATABASE_URL`; the local database and its demo data are never a production storage option.

PGlite supports one process per data directory. Stop the current server before starting another server or running the demo seed. For independent instances, set a distinct `LOCAL_DATABASE_PATH` for each instance. Browser tests already use a separate database.

WaterCycle places an exclusive `.watercycle.lock` file beside each local data directory. It records the owning process and, on Linux, its boot and process-start identity. A second live opener is refused. Locks from a dead process or a restored snapshot can be reclaimed automatically. Only the owner removes its lock when closing. SIGTERM and SIGINT initiate database close; let the server finish shutting down before restarting it.

If a local database cannot open, preserve the entire directory before attempting recovery. Never delete or reseed it automatically: it may contain student records. Restore a known-good backup, or choose a new `LOCAL_DATABASE_PATH` for a fresh demo. The demo seed requires `LOCAL_DATABASE=true` and refuses to run against `DATABASE_URL`.
