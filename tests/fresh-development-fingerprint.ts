import { createHash } from 'node:crypto';
import { createDatabase } from '../src/lib/db';
async function main(){
const db=await createDatabase({directory:process.env.LOCAL_DATABASE_PATH});
try{
 const {rows:tables}=await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
 const snapshot:Record<string,unknown>={};
 for(const {tablename} of tables){const quoted='"'+tablename.replaceAll('"','""')+'"';snapshot[tablename]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${quoted} t ORDER BY to_jsonb(t)::text`)).rows;}
 console.log(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
}finally{await db.close();}

}
main().catch(()=>{console.error("Unable to inspect isolated fixture.");process.exitCode=1;});
