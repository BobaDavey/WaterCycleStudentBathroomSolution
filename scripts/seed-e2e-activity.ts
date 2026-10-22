import path from 'node:path';
import { createDatabase } from '../src/lib/db';

async function main() {
  // This fixture is never part of Codespaces setup or production seeding.
  if(process.env.DATABASE_URL || process.env.LOCAL_DATABASE_PATH!=='.local/e2e-data' || process.env.DEMO_MODE!=='true')throw new Error('Activity fixtures require the isolated browser-test database.');
  const db=await createDatabase({directory:path.join(process.cwd(),'.local/e2e-data'),bootstrapAdmin:false});
  try {
    for(const [id,code,minutes,hours] of [
      ['e2e-jamie-older','01001',18,28],['e2e-jamie-newer','01001',13,25],
      ['e2e-other-period','01002',15,24],['e2e-other-teacher','02001',20,23],
    ] as const) {
      const {rows:[student]}=await db.query(`SELECT u.id,e.classroom_id FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE JOIN classrooms c ON c.id=e.classroom_id WHERE c.code=$1 AND ($1<>'01001' OR u.username='jamiechen') ORDER BY u.username LIMIT 1`,[code]);
      if(!student)throw new Error('The sample class roster is missing.');
      await db.query(`INSERT INTO visits(id,student_id,classroom_id,status,purpose,requested_at,left_at,returned_at)
        VALUES($1,$2,$3,'returned','restroom',statement_timestamp()-$4*INTERVAL '1 hour'-INTERVAL '1 minute',statement_timestamp()-$4*INTERVAL '1 hour',statement_timestamp()-$4*INTERVAL '1 hour'+$5*INTERVAL '1 minute') ON CONFLICT(id) DO NOTHING`,[id,student.id,student.classroom_id,hours,minutes]);
    }
  }finally{await db.close();}
}
main().catch(()=>{console.error('Unable to prepare isolated activity fixtures.');process.exitCode=1;});
