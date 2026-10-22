import { createDatabase } from '../src/lib/db';
import { bootstrapAdministrator } from '../src/lib/bootstrap-admin';

async function main() {
 const db = await createDatabase({ url:process.env.DATABASE_URL, directory:process.env.LOCAL_DATABASE_PATH, bootstrapAdmin:false });
 try {
  const result=await bootstrapAdministrator(db,process.env.ADMIN_INITIAL_PASSWORD);
  if (result === 'missing-secret') throw new Error('Set ADMIN_INITIAL_PASSWORD privately in the process environment or ignored .env.local, then run admin:bootstrap again. No password was invented.');
  console.log(result === 'created' ? 'The administrator account was created securely. Remove the initial-password secret after verifying sign-in.' : 'The administrator already exists. Its current password was preserved.');
 } finally { await db.close(); }
}
main().catch(error=>{console.error(error instanceof Error ? error.message : 'Administrator provisioning failed.');process.exitCode=1;});
