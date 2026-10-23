import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseConfigurationError} from '../src/lib/database-policy';
import {serverDiagnostic,logRequestFailure} from '../src/lib/server-diagnostics';

test('classifies schema, role, isolation, credentials, connection and TLS failures without raw exception details',()=>{
 for(const [error,category,code] of [
  [new DatabaseConfigurationError('private settings'),'database_configuration','DB_CONFIGURATION'],
  [new DatabaseConfigurationError('private settings','DB_IDENTITY_MISMATCH'),'database_identity','DB_IDENTITY_MISMATCH'],
  [new DatabaseConfigurationError('private settings','DB_SCHEMA_INCOMPATIBLE'),'database_schema','DB_SCHEMA_INCOMPATIBLE'],
  [new DatabaseConfigurationError('private settings','DB_RUNTIME_ROLE_UNSAFE'),'database_permissions','DB_RUNTIME_ROLE_UNSAFE'],
  [{code:'42P01'},'database_schema','DB_MIGRATIONS_REQUIRED'],
  [{code:'42703'},'database_schema','DB_MIGRATIONS_REQUIRED'],
  [{code:'42501'},'database_permissions','DB_PERMISSIONS'],
  [{code:'28P01'},'database_authentication','DB_AUTHENTICATION'],
  [{code:'08006'},'database_connectivity','DB_CONNECTION'],
  [{code:'08P01'},'database_protocol','DB_PROTOCOL'],
  [{code:'ECONNREFUSED'},'database_connectivity','DB_CONNECTION'],
  [{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'},'database_tls','DB_TLS'],
  [{code:'42601'},'internal','DB_QUERY_FAILED'],
  [new Error('Connection terminated due to connection timeout'),'database_connectivity','DB_CONNECTION'],
  [new Error('wrapper',{cause:new AggregateError([{code:'ENOTFOUND'}])}),'database_connectivity','DB_CONNECTION'],
  [new Error('application bug'),'internal','INTERNAL_ERROR'],
 ] as const){const diagnostic=serverDiagnostic(error);assert.equal(diagnostic.category,category);assert.equal(diagnostic.code,code);}
});

test('production request logging never serializes driver secrets, account data, SQL, stack or unrecognized codes',t=>{
 const calls:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>calls.push(args));
 const secret='do-not-log-private-credentials-or-student-information';
 const error=Object.assign(new Error(secret),{name:'error',code:'42501',detail:secret,query:secret,parameters:[secret],connectionString:`postgresql://user:${secret}@private/database`,stack:secret});
 const diagnostic=logRequestFailure(error,{requestId:'test-reference',method:'GET',endpoint:'/api/auth/me',stage:'database_initialization'});
 assert.equal(diagnostic.code,'DB_PERMISSIONS');
 const output=JSON.stringify(calls);assert.ok(!output.includes(secret));assert.ok(!output.includes('postgresql://'));
 const payload=JSON.parse(calls[0][1] as string);
 assert.equal(payload.requestId,'test-reference');assert.equal(payload.endpoint,'/api/auth/me');assert.equal(payload.sqlState,'42501');assert.equal(payload.stage,'database_initialization');
 assert.equal(serverDiagnostic({code:secret,message:secret,stack:secret}).code,'INTERNAL_ERROR');
 assert.equal(serverDiagnostic({code:'42601',message:secret}).sqlState,'42601');
 const cyclic:{cause?:unknown}={};cyclic.cause=cyclic;assert.equal(serverDiagnostic(cyclic).code,'INTERNAL_ERROR');
});
