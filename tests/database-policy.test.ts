import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assertDemoSeedAllowed, assertLocalDatabaseAllowed, managedConfiguration, validateDeploymentBuild, validatePostgresUrl } from '../src/lib/database-policy';
const databaseId='6d19cc08-4e50-4f43-af28-ea47c98462f8';
const base={VERCEL:'1',VERCEL_ENV:'production',WATERCYCLE_ENVIRONMENT:'production',WATERCYCLE_DATABASE_ID:databaseId,DATABASE_URL:'postgresql://app:example@database.example/classroom?sslmode=verify-full'};
test('Vercel production and preview always require managed PostgreSQL and matching environment scopes',()=>{
 for(const scope of ['production','preview']){
  const env={...base,VERCEL_ENV:scope,WATERCYCLE_ENVIRONMENT:scope};assert.equal(managedConfiguration(env).binding.environment,scope);
  for(const change of [{DATABASE_URL:''},{LOCAL_DATABASE:'true'},{DEMO_MODE:'true'},{LOCAL_DATABASE_PATH:'/tmp/data'},{WATERCYCLE_DATABASE_ID:''},{WATERCYCLE_ENVIRONMENT:scope==='production'?'preview':'production'}])assert.throws(()=>managedConfiguration({...env,...change}));
  assert.throws(()=>assertLocalDatabaseAllowed({...env,LOCAL_DATABASE:'true'}));
 }
 assert.throws(()=>managedConfiguration({...base,VERCEL_ENV:''}));
});
test('build validation fails before deployment for invalid managed settings without making a database connection',()=>{
 assert.doesNotThrow(()=>validateDeploymentBuild({LOCAL_DATABASE:'true',DEMO_MODE:'true'}));
 assert.doesNotThrow(()=>validateDeploymentBuild(base));assert.throws(()=>validateDeploymentBuild({...base,DATABASE_URL:''}));
});
test('database URLs enforce PostgreSQL and TLS and reject connection/schema redirection options without leaking credentials',()=>{
 for(const input of ['memory://','file:///tmp/db','postgresql://host','postgresql://u:private@host/db?sslmode=disable','postgresql://u:private@host/db?options=-c%20search_path%3Dother','postgresql://u:private@host/db?host=other','postgresql://u:private@host/db?ssl=false','postgresql://u:private@host/db?sslmode=require&sslmode=disable']){
  assert.throws(()=>validatePostgresUrl(input,true),error=>error instanceof Error&&!error.message.includes('private'));
 }
 assert.equal(validatePostgresUrl(base.DATABASE_URL,true),base.DATABASE_URL);
});
test('demo setup cannot run in any hosted environment, production build, or against any managed database URL',()=>{
 assert.doesNotThrow(()=>assertDemoSeedAllowed({LOCAL_DATABASE:'true'}));
 for(const extra of [{VERCEL:'1'},{WATERCYCLE_ENVIRONMENT:'production'},{WATERCYCLE_ENVIRONMENT:'preview'},{NODE_ENV:'production'},{DATABASE_URL:base.DATABASE_URL},{MIGRATION_DATABASE_URL:base.DATABASE_URL},{LOCAL_DATABASE:'false'}])assert.throws(()=>assertDemoSeedAllowed({LOCAL_DATABASE:'true',...extra}));
});
test('runtime uses only DATABASE_URL and maintenance may use a separate credential for the same environment identity',()=>{
 const env={...base,MIGRATION_DATABASE_URL:'postgresql://owner:example@database.example/classroom?sslmode=require'};
 assert.equal(managedConfiguration({...env,VERCEL:'0',NODE_ENV:'production'}).url,base.DATABASE_URL);assert.equal(managedConfiguration(env,'operator').url,env.MIGRATION_DATABASE_URL);
 assert.throws(()=>managedConfiguration(env),/migration credentials/);
 assert.equal(managedConfiguration(env,'operator').binding.databaseId,base.WATERCYCLE_DATABASE_ID);
});
test('Vercel install, build, and start commands contain no migrations, bootstrap, seed, or reset hooks',async()=>{
 const manifest=JSON.parse(await readFile('package.json','utf8'));const vercel=JSON.parse(await readFile('vercel.json','utf8'));
 assert.equal(vercel.installCommand,'npm ci');assert.equal(vercel.buildCommand,'npm run build');
 for(const name of ['preinstall','install','postinstall','prepare','prebuild','build','postbuild','prestart','start','poststart'])assert.doesNotMatch(manifest.scripts[name]??'',/migrate|bootstrap|seed|reset|truncate|drop database/i);
 assert.equal(manifest.scripts.build,'next build');
});

test('rejects database and initialization secrets exposed through NEXT_PUBLIC_ variables',()=>{
 for(const key of ['NEXT_PUBLIC_DATABASE_URL','NEXT_PUBLIC_MIGRATION_DATABASE_URL','NEXT_PUBLIC_ADMIN_INITIAL_PASSWORD'])assert.throws(()=>managedConfiguration({...base,[key]:'private'}),/NEXT_PUBLIC_/);
});

test('maintenance-only credentials cannot make application startup fall back to local storage',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'watercycle-policy-'));const data=path.join(directory,'must-not-exist');
 try{
 const script="const {getDatabase}=require('./src/lib/db.ts');try{getDatabase();process.exitCode=7;}catch(error){if(!error.message.includes('Maintenance credentials'))process.exitCode=8;}";
 execFileSync(process.execPath,['--import','tsx','-e',script],{env:{...process.env,VERCEL:'0',VERCEL_ENV:'development',WATERCYCLE_ENVIRONMENT:'development',DATABASE_URL:'',MIGRATION_DATABASE_URL:base.DATABASE_URL,LOCAL_DATABASE:'true',LOCAL_DATABASE_PATH:data},stdio:'pipe'});
 await assert.rejects(()=>access(data));
 }finally{await rm(directory,{recursive:true,force:true});}
});
