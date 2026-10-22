import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';
import { WaterCycle } from '../src/lib/domain';

async function seed() {
 if (process.env.LOCAL_DATABASE !== 'true' || process.env.DATABASE_URL) throw new Error('Demo seeding is only allowed with LOCAL_DATABASE=true and no DATABASE_URL.');
 const db=await createDatabase({directory:process.env.LOCAL_DATABASE_PATH});
 try {
  const {rows}=await db.query("SELECT id FROM users WHERE role='teacher' LIMIT 1");
  if (rows.length) { console.log('A teacher already exists. Existing data was preserved.'); return; }
  const teacherHash=await hashPassword('WaterCycle2026!');
  const studentHash=await hashPassword('Biology2026!');
  const classroomId=randomUUID();
  await db.transaction(async tx=>{
   await tx.query('INSERT INTO classrooms(id,name,code) VALUES($1,$2,$3)',[classroomId,'AP Biology · Period 2','BIO2026']);
   await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES($1,'teacher','Morgan','Reed','morganreed',$2,$3)`,[randomUUID(),teacherHash,classroomId]);
   await new WaterCycle(db).seedQuestions(tx,classroomId);
   const roster=[['Jamie','Chen'],['Alex','Rivera'],['Sam','Patel'],['Jordan','Lee'],['Taylor','Brooks'],['Avery','Williams'],['Riley','Johnson'],['Casey','Nguyen'],['Quinn','Davis'],['Emerson','Garcia'],['Charlie','Wilson'],['Dakota','Martinez']];
   for (const [first,last] of roster) {
    const id=randomUUID();
    await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES($1,'student',$2,$3,$4,$5,$6)`,[id,first,last,`${first}${last}`.toLowerCase(),studentHash,classroomId]);
    // Historical, completed trips illustrate reporting without putting anyone out or in line.
    if (first !== 'Jamie') await tx.query(`INSERT INTO visits(id,classroom_id,student_id,status,requested_at,ready_at,left_at,returned_at) VALUES($1,$2,$3,'returned',CURRENT_TIMESTAMP-INTERVAL '42 minutes',CURRENT_TIMESTAMP-INTERVAL '42 minutes',CURRENT_TIMESTAMP-INTERVAL '41 minutes',CURRENT_TIMESTAMP-INTERVAL '37 minutes')`,[randomUUID(),classroomId,id]);
   }
  });
  console.log('Local demo prepared: 1 teacher, 12 students, 20 questions, completed sample trips. No active passes.');
 } finally {await db.close();}
}
seed().catch(error=>{console.error(error instanceof Error?error.message:'Seed failed');process.exitCode=1;});
