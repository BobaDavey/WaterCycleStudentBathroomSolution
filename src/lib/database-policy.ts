export type DatabaseEnvironment = 'production' | 'preview' | 'development';
export interface DatabaseBinding { environment: DatabaseEnvironment; databaseId: string; }
export type Environment = Record<string, string | undefined>;
export type DatabaseConfigurationCode = 'DB_CONFIGURATION' | 'DB_MIGRATIONS_REQUIRED' | 'DB_SCHEMA_INCOMPATIBLE' | 'DB_IDENTITY_MISMATCH' | 'DB_RUNTIME_ROLE_UNSAFE' | 'DB_PERMISSIONS';
export class DatabaseConfigurationError extends Error { constructor(message:string,public readonly code:DatabaseConfigurationCode='DB_CONFIGURATION'){super(message);this.name='DatabaseConfigurationError';} }
function fail(message:string):never { throw new DatabaseConfigurationError(message); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function hosted(env:Environment) { return env.VERCEL === '1' || env.WATERCYCLE_ENVIRONMENT === 'production' || env.WATERCYCLE_ENVIRONMENT === 'preview'; }
export function assertLocalDatabaseAllowed(env:Environment) {
 if(hosted(env)) fail('Local database storage is forbidden in hosted production and preview environments. Configure managed PostgreSQL.');
}
export function assertDemoSeedAllowed(env:Environment) {
 assertLocalDatabaseAllowed(env);
 if(Object.keys(env).some(key=>key.startsWith('NEXT_PUBLIC_')&&/(DATABASE_URL|ADMIN_INITIAL_PASSWORD)/.test(key)&&env[key]))fail('Database URLs and initialization secrets must never use NEXT_PUBLIC_ environment variables.');
 if(env.NODE_ENV==='production'||env.LOCAL_DATABASE!=='true'||env.DATABASE_URL||env.MIGRATION_DATABASE_URL) fail('Demo seeding requires an explicitly enabled local development database and no managed database URLs.');
}
export function validatePostgresUrl(value:string, requireTls=false):string {
 let parsed:URL;
 try {parsed=new URL(value);} catch {return fail('The database connection must be a valid PostgreSQL URL. Its value was not logged.');}
 if(!['postgres:','postgresql:'].includes(parsed.protocol)||!parsed.hostname||parsed.pathname.length<2||parsed.hash)fail('Configure a PostgreSQL URL with a host and database name.');
 // URL query overrides must not silently redirect libpq/pg to another database or schema.
 const allowed=new Set(['sslmode','sslrootcert','sslcert','sslkey','channel_binding','application_name','connect_timeout']);
 for(const key of parsed.searchParams.keys())if(!allowed.has(key))fail('Unsupported database URL option. Use the provider PostgreSQL URL without host, role, schema, or TLS overrides.');
 for(const key of allowed)if(parsed.searchParams.getAll(key).length>1)fail('Duplicate database URL options are not permitted.');
 const mode=parsed.searchParams.get('sslmode');
 if(requireTls && !['require','verify-ca','verify-full'].includes(mode??''))fail('Hosted PostgreSQL connections require sslmode=require or certificate verification. Do not disable TLS.');
 return value;
}
export function managedConfiguration(env:Environment, purpose:'runtime'|'operator'='runtime'):{url:string;binding:DatabaseBinding} {
 if(env.CODESPACES==='true')fail('Codespaces use isolated local demo data. Remove DATABASE_URL and MIGRATION_DATABASE_URL from Codespaces secrets and run npm run dev:setup. Managed connections are refused.');
 if(purpose==='runtime' && env.VERCEL!=='1' && env.NODE_ENV!=='production' && env.WATERCYCLE_ENVIRONMENT!=='development')fail('Local previews can connect only to a database bound to development. Use npm run dev:setup for an isolated demo.');
 if(Object.keys(env).some(key=>key.startsWith('NEXT_PUBLIC_')&&/(DATABASE_URL|ADMIN_INITIAL_PASSWORD)/.test(key)&&env[key]))fail('Database URLs and initialization secrets must never use NEXT_PUBLIC_ environment variables.');
 if(purpose==='runtime'&&env.VERCEL==='1'&&env.MIGRATION_DATABASE_URL)fail('Keep migration credentials outside the Vercel runtime environment.');
 const environment=env.WATERCYCLE_ENVIRONMENT;
 if(!['production','preview','development'].includes(environment??''))fail('Set WATERCYCLE_ENVIRONMENT to production, preview, or development.');
 if(env.VERCEL==='1'){
  if(!['production','preview','development'].includes(env.VERCEL_ENV??''))fail('A recognized Vercel environment is required.');
  if(environment!==env.VERCEL_ENV)fail('WATERCYCLE_ENVIRONMENT does not match the Vercel deployment environment.');
 }
 if(env.LOCAL_DATABASE==='true'||env.DEMO_MODE==='true'||env.LOCAL_DATABASE_PATH)fail('Managed deployments must not enable local storage, local database paths, or demo mode.');
 if(!uuid.test(env.WATERCYCLE_DATABASE_ID??''))fail('Set a stable UUID in WATERCYCLE_DATABASE_ID for this database; use a different UUID for preview.');
 const url=purpose==='operator'?(env.MIGRATION_DATABASE_URL||env.DATABASE_URL):env.DATABASE_URL;
 if(!url)fail(purpose==='operator'?'Set MIGRATION_DATABASE_URL for database maintenance.':'DATABASE_URL is required. WaterCycle will not fall back to local storage.');
 validatePostgresUrl(url,hosted(env));
 return{url,binding:{environment:environment as DatabaseEnvironment,databaseId:env.WATERCYCLE_DATABASE_ID!}};
}
export function validateDeploymentBuild(env:Environment) { if(hosted(env))managedConfiguration(env); }
