import { inspectDatabase, maintenanceConfiguration, maintenanceFailure } from './database-maintenance';
async function main(){const config=maintenanceConfiguration();const status=await inspectDatabase(config.url,config.binding);console.log(JSON.stringify({environment:config.binding.environment,databaseId:config.binding.databaseId,...status},null,2));}
main().catch(maintenanceFailure);
