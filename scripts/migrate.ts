import { parseArgs } from 'node:util';
import { createDatabase } from '../src/lib/db';
import { DatabaseConfigurationError } from '../src/lib/database-policy';
import { maintenanceConfiguration, maintenanceFailure } from './database-maintenance';
async function main(){
 const {values}=parseArgs({options:{'expected-version':{type:'string'},'backup-reference':{type:'string'}}});
 const raw=values['expected-version'];
 if(raw===undefined||!/^\d+$/.test(raw))throw new DatabaseConfigurationError('Supply --expected-version from the reviewed db:status output and --backup-reference for a verified snapshot or backup.');
 const config=maintenanceConfiguration();
 const db=await createDatabase({url:config.url,binding:config.binding,bootstrapAdmin:false,migration:{expectedVersion:Number(raw),backupReference:values['backup-reference']}});
 try{console.log('Database migrations and environment binding completed. Existing accounts and records were retained.');}finally{await db.close();}
}
main().catch(maintenanceFailure);
