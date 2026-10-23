import { createDatabase } from '../src/lib/db';
import { managedConfiguration } from '../src/lib/database-policy';
import { sessionUser } from '../src/lib/auth';
import { maintenanceFailure } from './database-maintenance';

async function main(){
 // Uses DATABASE_URL only, with all normal environment/role/isolation checks.
 // Run outside Codespaces in a trusted operator terminal with NODE_ENV=production.
 const config=managedConfiguration(process.env);
 const db=await createDatabase({url:config.url,binding:config.binding});
 try{
  await db.transaction(async tx=>{
   await tx.query('SET TRANSACTION READ ONLY');
   await tx.query("SELECT EXISTS(SELECT 1 FROM public.users WHERE role='admin') AS provisioned");
   await sessionUser(tx);
  });
  console.log(JSON.stringify({ok:true,checks:['connectivity','migrations','environment_identity','restricted_runtime_permissions','unauthenticated_auth_state']},null,2));
 }finally{await db.close();}
}
main().catch(maintenanceFailure);
