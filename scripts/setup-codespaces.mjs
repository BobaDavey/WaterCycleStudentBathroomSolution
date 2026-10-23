import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { loadDevelopmentEnvironment } from './development-environment.mjs';

try {
 loadDevelopmentEnvironment();
 if (process.env.VERCEL==='1' || process.env.NODE_ENV==='production' || (process.env.WATERCYCLE_ENVIRONMENT && process.env.WATERCYCLE_ENVIRONMENT!=='development') || process.env.DATABASE_URL || process.env.MIGRATION_DATABASE_URL) {
  throw new Error('Development setup refused: hosted settings or managed database URLs are present. Remove production database configuration from Codespaces; never copy production connection secrets here. No database was opened.');
 }
 if (process.env.LOCAL_DATABASE==='false'||process.env.DEMO_MODE==='false') throw new Error('Enable LOCAL_DATABASE=true and DEMO_MODE=true for this isolated development demo.');
 if (existsSync('.env.local') && (process.env.LOCAL_DATABASE!=='true'||process.env.DEMO_MODE!=='true'||process.env.WATERCYCLE_ENVIRONMENT!=='development')) throw new Error('Existing local configuration is incomplete. Set LOCAL_DATABASE=true, DEMO_MODE=true and WATERCYCLE_ENVIRONMENT=development in .env.local. The file was preserved.');
 if (!existsSync('.env.local')) {
  writeFileSync('.env.local','WATERCYCLE_ENVIRONMENT=development\nLOCAL_DATABASE=true\nDEMO_MODE=true\n',{flag:'wx',mode:0o600});
 }
 loadDevelopmentEnvironment(true);
 const result=spawnSync('npm',['run','db:seed'],{stdio:'inherit',env:{...process.env,WATERCYCLE_ENVIRONMENT:'development',LOCAL_DATABASE:'true',DEMO_MODE:'true'}});
 if(result.error)throw result.error;
 if(result.status===75&&process.argv.includes('--if-idle'))console.log('WaterCycle is already running; its database was preserved. Stop and restart npm run dev to apply newly configured development secrets.');
 else if(result.status!==0)process.exitCode=result.status??1;
 else console.log('Development setup complete. Run npm run dev, open port 3000, and enter the development demo credentials from README.md.');
}catch(error){
 console.error(error instanceof Error?error.message:'Development setup failed. See README.md.');process.exitCode=1;
}
