import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import { bootstrapDevelopmentAdministrator } from '../src/lib/development-admin';
import { ADMIN_USERNAME, bootstrapAdministrator, allowedAdministrator } from '../src/lib/bootstrap-admin';
import { WaterCycle } from '../src/lib/domain';
import { managedConfiguration, DatabaseConfigurationError } from '../src/lib/database-policy';
import { developmentDiagnostic } from '../src/lib/development-diagnostics';

process.env.LOCAL_DATABASE='true';
test('local databases never automatically consume a production administrator bootstrap secret',async()=>{
 const previous=process.env.ADMIN_INITIAL_PASSWORD;process.env.ADMIN_INITIAL_PASSWORD=randomBytes(24).toString('hex');
 const db=await createDatabase({directory:'memory://'});
 try{assert.equal((await db.query("SELECT id FROM users WHERE role='admin'")).rows.length,0);}
 finally{await db.close();if(previous===undefined)delete process.env.ADMIN_INITIAL_PASSWORD;else process.env.ADMIN_INITIAL_PASSWORD=previous;}
});
test('opt-in local administrator uses a separate identity, real authentication, singleton protection, and unchanged password on repeat',async()=>{
 const db=await createDatabase({directory:'memory://'});const secret=randomBytes(24).toString('base64url');
 try{
  assert.equal(await bootstrapDevelopmentAdministrator(db),'missing-secret');
  assert.equal(await bootstrapDevelopmentAdministrator(db,secret),'created');
  const before=(await db.query("SELECT * FROM users WHERE role='admin'")).rows;
  const app=new WaterCycle(db);const admin=await app.login({role:'admin',username:'watercycledev',password:secret});
  assert.equal(admin.firstName,'Development');assert.equal((await app.adminState(admin)).user.username,'watercycledev');
  await assert.rejects(()=>app.login({role:'admin',username:ADMIN_USERNAME,password:secret}),/incorrect/);
  await assert.rejects(()=>app.login({role:'teacher',username:'watercycledev',password:secret}),/incorrect/);
  await assert.rejects(()=>app.login({role:'admin',username:'watercycledev',password:'IncorrectPassword'}),/incorrect/);
  assert.equal(await bootstrapDevelopmentAdministrator(db,randomBytes(24).toString('hex')),'exists');
  assert.deepEqual((await db.query("SELECT * FROM users WHERE role='admin'")).rows,before);
  for(const sql of ["DELETE FROM users WHERE role='admin'","UPDATE users SET enabled=FALSE WHERE role='admin'","UPDATE users SET username='otheradmin' WHERE role='admin'","UPDATE users SET role='teacher' WHERE role='admin'"])await assert.rejects(()=>db.query(sql));
  await app.updateAdminProfile(admin,{firstName:'Local',lastName:'Administrator'});
  assert.equal((await db.query("SELECT first_name FROM users WHERE role='admin'")).rows[0].first_name,'Local');
 }finally{await db.close();}
});
test('local bootstrap preserves an existing privileged account and managed databases cannot accept the development administrator',async()=>{
 const db=await createDatabase({directory:'memory://'});const secret=randomBytes(24).toString('hex');
 try{
  await bootstrapAdministrator(db,secret);const before=(await db.query('SELECT * FROM users')).rows;
  await assert.rejects(()=>bootstrapDevelopmentAdministrator(db,secret),/existing administrator/);
  assert.deepEqual((await db.query('SELECT * FROM users')).rows,before);
  assert.equal(allowedAdministrator({query:db.query},'watercycledev'),false);
  await assert.rejects(()=>bootstrapDevelopmentAdministrator({localDevelopment:false} as Database,secret),/isolated local/);
  await assert.rejects(()=>db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('dev','admin','Development','Administrator','watercycledev')"));
 }finally{await db.close();}
});
test('development administrator bootstrap refuses a managed identity before modifying the local schema',async()=>{
 const db=await createDatabase({directory:'memory://'});
 try{
  await db.query("INSERT INTO watercycle_database_identity(environment,database_id) VALUES('production','6d19cc08-4e50-4f43-af28-ea47c98462f8')");
  await assert.rejects(()=>bootstrapDevelopmentAdministrator(db,randomBytes(24).toString('hex')),/managed environment/);
  assert.equal((await db.query('SELECT * FROM users')).rows.length,0);
  assert.match(String((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='administrator_identity'")).rows[0].definition),new RegExp(ADMIN_USERNAME));
 }finally{await db.close();}
});
test('Codespaces cannot connect to managed databases even with otherwise valid production or development bindings',async()=>{
 for(const environment of ['production','preview','development'])assert.throws(()=>managedConfiguration({CODESPACES:'true',NODE_ENV:'production',WATERCYCLE_ENVIRONMENT:environment,DATABASE_URL:'postgresql://example.invalid/demo?sslmode=require',WATERCYCLE_DATABASE_ID:'6d19cc08-4e50-4f43-af28-ea47c98462f8'}),/Codespaces/);
 assert.throws(()=>managedConfiguration({WATERCYCLE_ENVIRONMENT:'production'}),/Local previews/);
 const previous=process.env.CODESPACES;process.env.CODESPACES='true';
 try{await assert.rejects(()=>createDatabase({url:'not-a-connection-string',binding:{environment:'production',databaseId:'6d19cc08-4e50-4f43-af28-ea47c98462f8'}}),/Codespaces use isolated/);}
 finally{if(previous===undefined)delete process.env.CODESPACES;else process.env.CODESPACES=previous;}
});
test('setup diagnostics distinguish missing config, missing migrations and unavailable database without leaking production information',()=>{
 const env={NODE_ENV:'development'};
 assert.match(developmentDiagnostic(new DatabaseConfigurationError('Set local configuration.'),env)!,/configuration/);
 assert.match(developmentDiagnostic({code:'42P01'},env)!,/migrations/);
 assert.match(developmentDiagnostic({code:'ECONNREFUSED'},env)!,/unavailable/);
 for(const production of [{NODE_ENV:'production'},{VERCEL:'1'},{WATERCYCLE_ENVIRONMENT:'preview'}])assert.equal(developmentDiagnostic(new DatabaseConfigurationError('private diagnostic'),production),null);
});
