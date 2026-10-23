import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { maintenanceConfiguration, maintenanceFailure, inspectDatabase } from './database-maintenance';
import { DatabaseConfigurationError } from '../src/lib/database-policy';
async function main(){
 const {values}=parseArgs({options:{output:{type:'string'}}});
 if(!values.output)throw new DatabaseConfigurationError('Choose a private backup file with --output. Existing files will not be overwritten.');
 const config=maintenanceConfiguration();await inspectDatabase(config.url,config.binding);
 const destination=path.resolve(values.output);const file=await open(destination,'wx',0o600);
 let success=false;
 try{
  const url=new URL(config.url);
  const env={...process.env,PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:url.searchParams.get('sslmode')??'prefer',PGOPTIONS:'-c search_path=public',PGCONNECT_TIMEOUT:url.searchParams.get('connect_timeout')??'15'};
  for(const [parameter,variable] of [['sslrootcert','PGSSLROOTCERT'],['sslcert','PGSSLCERT'],['sslkey','PGSSLKEY'],['channel_binding','PGCHANNELBINDING']] as const){const value=url.searchParams.get(parameter);if(value)Object.assign(env,{[variable]:value});}
  const digest=createHash('sha256');
  const child=spawn('pg_dump',['--format=custom','--no-owner','--no-acl'],{env,stdio:['ignore','pipe','pipe']});
  let failed=false;child.stderr.on('data',()=>{ /* Keep private connection diagnostics out of logs. */ });
  const done=new Promise<number|null>(resolve=>{child.once('error',()=>resolve(null));child.once('exit',resolve);});
  try{for await(const chunk of child.stdout){digest.update(chunk);await file.writeFile(chunk);}}catch{failed=true;child.kill('SIGTERM');}
  const code=await done;
  if(code!==0||failed)throw new DatabaseConfigurationError('Backup failed. Install matching PostgreSQL client tools and check private credentials/provider access. No migration was run.');
  await file.sync();success=true;console.log(`Backup saved with private permissions. SHA-256: ${digest.digest('hex')}. Verify restoration in an isolated database before using this backup as a migration reference.`);
 }finally{await file.close();if(!success)await unlink(destination).catch(()=>{});}
}
main().catch(maintenanceFailure);
