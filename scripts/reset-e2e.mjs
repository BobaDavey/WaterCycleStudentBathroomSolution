import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lockLocalDatabase } from '../src/lib/local-database-lock.ts';
import { assertDemoSeedAllowed } from '../src/lib/database-policy.ts';
assertDemoSeedAllowed(process.env);
// This fixed directory belongs exclusively to the Playwright fixture.
// Never accept a user-supplied path or touch the application's .local/data.
const directory = fileURLToPath(new URL('../.local/e2e-data', import.meta.url));
const release = await lockLocalDatabase(directory);
try { await rm(directory, { recursive: true, force: true }); }
finally { await release(); }
