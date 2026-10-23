import { spawn } from 'node:child_process';
import { loadDevelopmentEnvironment } from './development-environment.mjs';

loadDevelopmentEnvironment();
const local=process.env.CODESPACES==='true'||(!process.env.DATABASE_URL&&!process.env.MIGRATION_DATABASE_URL);
async function run(command,args){
 const child=spawn(command,args,{stdio:'inherit',env:process.env});
 const forward=signal=>{if(child.exitCode===null)child.kill(signal);};
 const term=()=>forward('SIGTERM'),int=()=>forward('SIGINT');
 process.on('SIGTERM',term);process.on('SIGINT',int);
 try{return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code??1));});}
 finally{process.removeListener('SIGTERM',term);process.removeListener('SIGINT',int);}
}
try{
 const setup=local?await run(process.execPath,['scripts/setup-codespaces.mjs']):0;
 if(setup!==0){console.error('WaterCycle did not start because development initialization failed. Follow the setup error above; existing data was preserved.');process.exitCode=setup;}
 else {
  loadDevelopmentEnvironment(true);
  // Give local database/cache cleanup time before Next force-kills its worker.
  process.env.NEXT_EXIT_TIMEOUT_MS ??= '10000';
  process.exitCode=await run(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','0.0.0.0',...process.argv.slice(2)]);
 }
}catch{console.error('WaterCycle could not start. Run npm install and check the development setup instructions in README.md.');process.exitCode=1;}
