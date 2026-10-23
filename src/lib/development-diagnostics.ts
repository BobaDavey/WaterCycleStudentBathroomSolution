import { DatabaseConfigurationError, hosted, type Environment } from './database-policy';

export function developmentDiagnostic(error:unknown,env:Environment):string|null {
 if(env.NODE_ENV==='production'||hosted(env))return null;
 if(error instanceof DatabaseConfigurationError)return `Development configuration missing or unsafe: ${error.message} See README.md and npm run dev:doctor.`;
 const code=(error as {code?:string}|null)?.code;
 if(code==='42P01'||code==='42703')return 'Development database migrations are incomplete. Stop the server and run npm run dev:doctor, then npm run dev:setup. Preserve existing data.';
 if(['ECONNREFUSED','ENOTFOUND','ETIMEDOUT','28P01','08006','57P03'].includes(code??''))return 'Development database unavailable. Check private configuration and database availability; run npm run dev:doctor for a local demo.';
 return null;
}
