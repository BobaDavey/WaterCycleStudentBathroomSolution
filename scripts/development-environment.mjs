import * as nextEnv from '@next/env';

// Match `next dev` precedence, including .env.development.local. Never log values.
export function loadDevelopmentEnvironment() {
 (nextEnv.loadEnvConfig ?? nextEnv.default.loadEnvConfig)(process.cwd(), true, { info() {}, error() { console.error('Unable to load development environment files. Check their syntax.'); } });
}
