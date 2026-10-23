import { spawnSync } from 'node:child_process';

if (process.env.VERCEL === '1' || ['production','preview'].includes(process.env.WATERCYCLE_ENVIRONMENT) || process.env.MIGRATION_DATABASE_URL) {
  console.log('Hosted or managed maintenance environment detected; local demo setup skipped.');
} else if (process.env.DATABASE_URL) {
  console.log('Existing PostgreSQL configuration preserved; local demo seed skipped.');
} else if (process.env.LOCAL_DATABASE === 'true' && process.env.DEMO_MODE === 'true') {
  const result = spawnSync('npm', ['run', 'db:seed'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  console.log('Local demo is not enabled. See README.md for classroom setup.');
}
