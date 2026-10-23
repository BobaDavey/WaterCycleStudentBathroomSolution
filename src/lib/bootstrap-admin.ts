import { randomUUID } from 'node:crypto';
import type { Database, SQL } from './db';
import { hashPassword } from './auth';

export const ADMIN_USERNAME = 'davidanzezhang';
export const DEVELOPMENT_ADMIN_USERNAME = ADMIN_USERNAME;
const legacyDevelopmentAdminUsername = 'watercycledev';
export function allowedAdministrator(db: SQL, username: unknown) {
 return username === ADMIN_USERNAME || (db.localDevelopment === true && username === legacyDevelopmentAdminUsername);
}
export function reservedAdministratorUsername(username: string) { return username === ADMIN_USERNAME || username === legacyDevelopmentAdminUsername; }
export type AdminBootstrapStatus = 'created' | 'exists' | 'missing-secret';

/** No public endpoint calls this helper. Existing passwords are never reset. */
export async function bootstrapAdministrator(db: Database, initialPassword?: string): Promise<AdminBootstrapStatus> {
 const { rows } = await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
 if (rows.length) return 'exists';
 if (!initialPassword) return 'missing-secret';
 if (initialPassword.length < 8 || initialPassword.length > 128) throw new Error('ADMIN_INITIAL_PASSWORD must contain 8–128 characters. Its value was not logged.');
 const hash = await hashPassword(initialPassword);
 return db.transaction(async tx => {
  await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
  const existing = await tx.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (existing.rows.length) return 'exists';
  const collision = await tx.query('SELECT id FROM users WHERE username=$1', [ADMIN_USERNAME]);
  if (collision.rows.length) throw new Error('The reserved administrator username is already assigned to a regular account. Preserve that account and resolve its username before provisioning.');
  await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,enabled,must_change_password)
   VALUES($1,'admin','David','Zhang',$2,$3,NULL,TRUE,FALSE)`, [randomUUID(),ADMIN_USERNAME,hash]);
  return 'created';
 });
}
