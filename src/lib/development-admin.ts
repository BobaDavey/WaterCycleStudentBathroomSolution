import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { hashPassword } from './auth';
import { DEVELOPMENT_ADMIN_USERNAME, type AdminBootstrapStatus } from './bootstrap-admin';
import { assertDemoSeedAllowed } from './database-policy';

/** Opt-in local schema policy. Never included in managed PostgreSQL migrations. */
export async function bootstrapDevelopmentAdministrator(db: Database, password?: string): Promise<AdminBootstrapStatus> {
 assertDemoSeedAllowed(process.env);
 if (!db.localDevelopment) throw new Error('Development administrators require an isolated local database.');
 if (!password) return 'missing-secret';
 if (password.length < 12 || password.length > 128) throw new Error('Choose a development-only password of 12–128 characters.');
 const hash = await hashPassword(password);
 return db.transaction(async tx => {
  await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
  const {rows:binding}=await tx.query('SELECT environment FROM watercycle_database_identity');
  if (binding.length) throw new Error('This database is bound to a managed environment. Development administrator setup refused.');
  const {rows:[existing]}=await tx.query("SELECT username FROM users WHERE role='admin'");
  if (existing) {
   if (existing.username!==DEVELOPMENT_ADMIN_USERNAME) throw new Error('An existing administrator was preserved. Choose a new LOCAL_DATABASE_PATH for a separate development demo.');
   return 'exists';
  }
  const collision=await tx.query('SELECT id FROM users WHERE username=$1',[DEVELOPMENT_ADMIN_USERNAME]);
  if(collision.rows.length)throw new Error('The development administrator username is in use. Existing data was preserved.');
  // This policy change is deliberately confined to this opted-in PGlite database.
  // Managed databases retain their original production-only CHECK and trigger.
  await tx.query('ALTER TABLE users DROP CONSTRAINT administrator_identity');
  await tx.query(`ALTER TABLE users ADD CONSTRAINT administrator_identity CHECK(role<>'admin' OR (username='watercycledev' AND enabled=TRUE AND classroom_id IS NULL))`);
  await tx.query(`CREATE OR REPLACE FUNCTION protect_watercycle_administrator() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   IF OLD.role='admin' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'The administrator account cannot be deleted.' USING ERRCODE='23514'; END IF;
    IF NEW.role<>'admin' OR NEW.username<>OLD.username OR NEW.enabled<>TRUE THEN
     RAISE EXCEPTION 'The administrator account cannot be demoted, renamed, or disabled.' USING ERRCODE='23514';
    END IF;
   END IF;
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
  END $$`);
  await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,enabled,must_change_password)
   VALUES($1,'admin','Development','Administrator',$2,$3,NULL,TRUE,FALSE)`,[randomUUID(),DEVELOPMENT_ADMIN_USERNAME,hash]);
  return 'created';
 });
}
