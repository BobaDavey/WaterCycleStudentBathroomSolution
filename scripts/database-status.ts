import { inspectDatabase, maintenanceConfiguration, maintenanceFailure } from './database-maintenance';
import { latestMigrationVersion } from '../src/lib/migrations';
async function main(){const config=maintenanceConfiguration();const status=await inspectDatabase(config.url,config.binding);console.log(JSON.stringify({environment:config.binding.environment,databaseId:config.binding.databaseId,currentVersion:status.versions.at(-1)??0,latestVersion:latestMigrationVersion,...status},null,2));}
main().catch(maintenanceFailure);
