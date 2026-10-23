// All destructive setup/cleanup belongs to this newly created Docker fixture.
// Never use DATABASE_URL, provider credentials, or an existing database/container.
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(tmpdir(),'watercycle-postgres-'));
const name=`watercycle-persistence-${randomUUID()}`;
const password=randomBytes(30).toString('base64url');
let created=false;
function command(binary,args){const result=spawnSync(binary,args,{encoding:'utf8'});if(result.error||result.status!==0)throw new Error(`Isolated fixture command failed: ${binary}. Check Docker/PostgreSQL tool availability.`);return result.stdout.trim();}
try{
 command('docker',['info','--format','{{.ServerVersion}}']);
 command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'server.key'),'-out',path.join(root,'server.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
 await writeFile(path.join(root,'container.env'),`POSTGRES_PASSWORD=${password}\nPOSTGRES_USER=fixture_owner\nPOSTGRES_DB=postgres\n`,{mode:0o600});
 command('docker',['create','--name',name,'--env-file',path.join(root,'container.env'),'-p','127.0.0.1::5432','postgres:17','bash','-c','chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key']);created=true;
 command('docker',['cp',path.join(root,'server.key'),`${name}:/tmp/server.key`]);command('docker',['cp',path.join(root,'server.crt'),`${name}:/tmp/server.crt`]);command('docker',['start',name]);
 let ready=false;for(let attempt=0;attempt<100;attempt++){const result=spawnSync('docker',['exec',name,'pg_isready','-U','fixture_owner'],{stdio:'ignore'});if(result.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}
 if(!ready)throw new Error('Isolated PostgreSQL did not become ready.');
 const port=command('docker',['port',name,'5432/tcp']).split(':').at(-1);
 const url=new URL(`postgresql://fixture_owner:${password}@127.0.0.1:${port}/postgres`);url.searchParams.set('sslmode','verify-full');url.searchParams.set('sslrootcert',path.join(root,'server.crt'));
 const env={...process.env,DATABASE_URL:'',MIGRATION_DATABASE_URL:'',ADMIN_INITIAL_PASSWORD:'',LOCAL_DATABASE:'',LOCAL_DATABASE_PATH:'',DEMO_MODE:'',VERCEL:'0',VERCEL_ENV:'development',WATERCYCLE_ENVIRONMENT:'development',WATERCYCLE_DATABASE_ID:'',NODE_ENV:'test',WATERCYCLE_POSTGRES_TEST_URL:url.toString(),WATERCYCLE_POSTGRES_CONTAINER:name,WATERCYCLE_POSTGRES_FIXTURE_ROOT:root};
 const child=spawn(process.execPath,['--import','tsx','--test','tests/postgres/persistence.test.ts'],{env,stdio:'inherit'});
 process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});
} catch(error){console.error(error instanceof Error?error.message:'Isolated PostgreSQL tests failed.');process.exitCode=1;}
finally{if(created)spawnSync('docker',['rm','-f','-v',name],{stdio:'ignore'});await rm(root,{recursive:true,force:true});}
