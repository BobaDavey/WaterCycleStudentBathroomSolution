import { randomUUID } from 'node:crypto';
import { DatabaseConfigurationError, type DatabaseConfigurationCode } from './database-policy';

type Category='database_configuration'|'database_schema'|'database_identity'|'database_permissions'|'database_authentication'|'database_connectivity'|'database_tls'|'database_protocol'|'internal';
export interface ServerDiagnostic {category:Category;code:string;hint:string;sqlState?:string;}
const configuration:Record<DatabaseConfigurationCode,ServerDiagnostic>={
 DB_CONFIGURATION:{category:'database_configuration',code:'DB_CONFIGURATION',hint:'Check private environment settings and the production database guide.'},
 DB_MIGRATIONS_REQUIRED:{category:'database_schema',code:'DB_MIGRATIONS_REQUIRED',hint:'Run db:status with operator credentials; review pending migrations and a verified backup before db:migrate. Startup never migrates.'},
 DB_SCHEMA_INCOMPATIBLE:{category:'database_schema',code:'DB_SCHEMA_INCOMPATIBLE',hint:'Stop and reconcile or restore the schema using the production database guide. Do not reset the ledger or recreate tables.'},
 DB_IDENTITY_MISMATCH:{category:'database_identity',code:'DB_IDENTITY_MISMATCH',hint:'Verify the database resource, deployment scope and stable database UUID. Do not rebind production as preview.'},
 DB_RUNTIME_ROLE_UNSAFE:{category:'database_permissions',code:'DB_RUNTIME_ROLE_UNSAFE',hint:'Use a restricted non-owner runtime role. Keep owner and migration credentials outside Vercel.'},
 DB_PERMISSIONS:{category:'database_permissions',code:'DB_PERMISSIONS',hint:'Review the runtime role grants in docs/production-database.md; do not grant ownership, DDL or broad privileges.'},
};
const connectivity=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','08000','08001','08003','08004','08006','08007','57P01','57P02','57P03','53300']);
const tls=new Set(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const queryErrors=new Set(['23502','23503','40001','40P01','42601','42704','42883','53100','53200','53400','55P03','57014','XX000']);

/** Allowlisted codes and fixed hints only: never serialize a driver Error,
 * message, stack, SQL, parameters, cookies, connection URL or account details. */
export function serverDiagnostic(error:unknown):ServerDiagnostic {
 const pending:unknown[]=[error],seen=new Set<unknown>();
 for(let index=0;index<pending.length&&index<12;index++){
  const candidate=pending[index];if(!candidate||typeof candidate!=='object'||seen.has(candidate))continue;seen.add(candidate);
  if(candidate instanceof DatabaseConfigurationError)return configuration[candidate.code];
  const {code,message,cause}=candidate as {code?:unknown;message?:unknown;cause?:unknown};
  const sqlState=typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?code:undefined;
  if(code==='42501'||code==='25006')return{...configuration.DB_PERMISSIONS,sqlState};
  if(code==='42P01'||code==='42703'||code==='3F000')return{...configuration.DB_MIGRATIONS_REQUIRED,sqlState};
  if(code==='28P01'||code==='28000')return{category:'database_authentication',code:'DB_AUTHENTICATION',sqlState,hint:'The database login was rejected. Check the private runtime role credentials; this is not an application user password failure.'};
  if(code==='3D000')return{category:'database_configuration',code:'DB_DATABASE_NOT_FOUND',sqlState,hint:'Check that the private connection targets the intended existing database. Do not create a replacement production resource.'};
  if(code==='08P01')return{category:'database_protocol',code:'DB_PROTOCOL',sqlState,hint:'Check provider pooler compatibility and connection startup settings; use a direct endpoint for maintenance.'};
  if(typeof code==='string'&&tls.has(code))return{category:'database_tls',code:'DB_TLS',hint:'Verify provider TLS settings and certificates. Do not disable certificate checks.'};
  if((typeof code==='string'&&connectivity.has(code))||(typeof message==='string'&&/^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/.test(message)))return{category:'database_connectivity',code:'DB_CONNECTION',...(sqlState?{sqlState}:{}),hint:'Check provider availability, connection limits, networking and the private runtime connection configuration.'};
  if(typeof code==='string'&&queryErrors.has(code))return{category:'internal',code:'DB_QUERY_FAILED',sqlState,hint:'Review the allowlisted SQLSTATE and request stage against this release. Raw SQL and driver details were omitted.'};
  if(cause)pending.push(cause);
  if(candidate instanceof AggregateError)pending.push(...candidate.errors.slice(0,8));
 }
 return{category:'internal',code:'INTERNAL_ERROR',hint:'Investigate this request reference in the server logs. No raw exception details were logged.'};
}
export type RequestStage='request_validation'|'database_initialization'|'session_lookup'|'authentication_state'|'application';
export function logRequestFailure(error:unknown,context:{requestId:string;method:string;endpoint:'/api/auth/me'|'/api/health'|'/api/[...path]';stage:RequestStage}) {
 const diagnostic=serverDiagnostic(error);
 console.error('WaterCycle request failed:',JSON.stringify({event:'watercycle.request_failed',...context,...diagnostic}));
 return diagnostic;
}
export function requestReference(){return randomUUID();}
