import { Pool } from 'pg';
import { managedConfiguration, type DatabaseBinding } from '../src/lib/database-policy';
import type { SQL } from '../src/lib/db';
import { schemaStatus } from '../src/lib/managed-database';
export function maintenanceConfiguration() {return managedConfiguration(process.env,'operator');}
export async function inspectDatabase(url:string,binding:DatabaseBinding) {
 const pool=new Pool({connectionString:url,options:'-c search_path=public',max:1,connectionTimeoutMillis:15000});
 try {
  const client=await pool.connect();
  try {await client.query('BEGIN READ ONLY');const status=await schemaStatus(client as SQL,binding);await client.query('COMMIT');return status;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
 }finally{await pool.end();}
}
export function maintenanceFailure(error:unknown) {
 // Connection failures can contain provider details; never print URLs, credentials, or raw SQL.
 const safe=error instanceof Error && error.name==='DatabaseConfigurationError';
 console.error(safe?error.message:'Database maintenance failed. Check the private connection configuration, permissions, and provider status. No credentials were logged.');process.exitCode=1;
}
