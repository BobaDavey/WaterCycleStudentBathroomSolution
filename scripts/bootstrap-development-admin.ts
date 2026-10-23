import { loadDevelopmentEnvironment } from './development-environment.mjs';
import { createDatabase } from '../src/lib/db';
import { assertDemoSeedAllowed } from '../src/lib/database-policy';
import { bootstrapDevelopmentAdministrator } from '../src/lib/development-admin';

async function secretPrompt(): Promise<string> {
 if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or supply DEV_ADMIN_INITIAL_PASSWORD privately in the process environment.');
 process.stdout.write('Choose a development-only administrator password (12–128 characters; hidden): ');
 const input=process.stdin;
 input.setRawMode(true);input.resume();input.setEncoding('utf8');
 return new Promise((resolve,reject)=>{
  let value='';
  const finish=()=>{input.setRawMode(false);input.pause();input.removeListener('data',onData);process.stdout.write('\n');};
  const onData=(chunk:string)=>{
   for(const char of chunk){
    if(char==='\u0003'){finish();reject(new Error('Administrator setup cancelled.'));return;}
    if(char==='\r'||char==='\n'){finish();resolve(value);return;}
    if(char==='\u007f'||char==='\b')value=value.slice(0,-1);
    else if(char>=' '&&value.length<129)value+=char;
   }
  };
  input.on('data',onData);
 });
}
async function main(){
 loadDevelopmentEnvironment();assertDemoSeedAllowed(process.env);
 const password=process.env.DEV_ADMIN_INITIAL_PASSWORD||await secretPrompt();
 const db=await createDatabase({directory:process.env.LOCAL_DATABASE_PATH,bootstrapAdmin:false});
 try{
  const result=await bootstrapDevelopmentAdministrator(db,password);
  console.log(result==='created'?'Development administrator created: watercycledev. Sign in at /admin/login with your chosen password.':'Development administrator already exists. Its password was preserved.');
 }finally{await db.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Development administrator setup failed.');process.exitCode=1;});
