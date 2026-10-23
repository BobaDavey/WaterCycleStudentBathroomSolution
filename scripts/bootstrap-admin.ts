import { createDatabase } from '../src/lib/db';
import { maintenanceFailure } from './database-maintenance';
import { hosted, managedConfiguration, DatabaseConfigurationError } from '../src/lib/database-policy';
import { bootstrapAdministrator } from '../src/lib/bootstrap-admin';

async function main() {
 const managed=hosted(process.env)||process.env.DATABASE_URL||process.env.MIGRATION_DATABASE_URL ? managedConfiguration(process.env,'operator') : null;
 if(!managed)throw new DatabaseConfigurationError('Production administrator bootstrap requires protected managed PostgreSQL configuration. For an isolated local administrator use npm run dev:admin.');
 const db=await createDatabase({url:managed.url,binding:managed.binding,bootstrapAdmin:false,operator:true});
 try {
  const result=await bootstrapAdministrator(db,process.env.ADMIN_INITIAL_PASSWORD);
  if (result === 'missing-secret') throw new Error('Set ADMIN_INITIAL_PASSWORD privately in the process environment or ignored .env.local, then run admin:bootstrap again. No password was invented.');
  console.log(result === 'created' ? 'The administrator account was created securely. Remove the initial-password secret after verifying sign-in.' : 'The administrator already exists. Its current password was preserved.');
 } finally { await db.close(); }
}
main().catch(maintenanceFailure);
