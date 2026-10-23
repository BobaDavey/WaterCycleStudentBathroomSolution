import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { hashPassword } from './auth';
import { DEVELOPMENT_ADMIN_USERNAME, type AdminBootstrapStatus } from './bootstrap-admin';
import { assertDemoSeedAllowed, type Environment } from './database-policy';

export function developmentAdminSecret(env: Environment): string | undefined {
 return env.DEV_ADMIN_INITIAL_PASSWORD || env.ADMIN_INITIAL_PASSWORD || undefined;
}

/** Explicit development setup only; never called by managed database startup. */
export async function bootstrapDevelopmentAdministrator(db: Database, password?: string): Promise<AdminBootstrapStatus | 'legacy-account'> {
 assertDemoSeedAllowed(process.env);
 if (!db.localDevelopment) throw new Error('Development administrators require an isolated local database.');
 return db.transaction(async tx => {
  await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
  if ((await tx.query('SELECT environment FROM watercycle_database_identity')).rows.length) {
   throw new Error('This database is bound to a managed environment. Development administrator setup refused.');
  }
  const {rows:[existing]}=await tx.query("SELECT username FROM users WHERE role='admin'");
  if (existing) {
   if (existing.username!==DEVELOPMENT_ADMIN_USERNAME) return 'legacy-account';
   return 'exists';
  }
  if (!password) return 'missing-secret';
  if (password.length < 8 || password.length > 128) throw new Error('The private development administrator secret must contain 8–128 characters. No secret value was logged; correct the Codespaces secret and restart.');
  if ((await tx.query('SELECT id FROM users WHERE username=$1',[DEVELOPMENT_ADMIN_USERNAME])).rows.length) {
   throw new Error('The required administrator username is in use by a regular account. Existing records were preserved; choose a separate LOCAL_DATABASE_PATH.');
  }
  const hash=await hashPassword(password);
  await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,enabled,must_change_password,account_status)
   VALUES($1,'admin','Development','Administrator',$2,$3,NULL,TRUE,FALSE,'active')`,[randomUUID(),DEVELOPMENT_ADMIN_USERNAME,hash]);
  return 'created';
 });
}
