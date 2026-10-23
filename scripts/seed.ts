import { randomUUID } from 'node:crypto';
import { createDatabase, type SQL } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';
import { assertDemoSeedAllowed } from '../src/lib/database-policy';
import { loadDevelopmentEnvironment } from './development-environment.mjs';
import { defaultQuestions } from '../src/lib/default-questions';
import { bootstrapDevelopmentAdministrator, developmentAdminSecret } from '../src/lib/development-admin';
import { LocalDatabaseBusyError } from '../src/lib/local-database-lock';

type Row = Record<string, unknown>;
async function seed() {
 loadDevelopmentEnvironment();
 assertDemoSeedAllowed(process.env);
 const db=await createDatabase({directory:process.env.LOCAL_DATABASE_PATH});
 try {
  const teacherHash=await hashPassword('WaterCycle2026!');
  const studentHash=await hashPassword('Biology2026!');
  const demoHash=await hashPassword('1234567890');
  await db.transaction(async tx=>{
   if((await tx.query('SELECT environment FROM watercycle_database_identity')).rows.length)throw new Error('Demo seeding refuses a database bound to a managed environment. Existing accounts were preserved.');
   async function teacher(first:string,last:string,username:string,hash=teacherHash) {
    const {rows:[existing]}=await tx.query<Row>('SELECT * FROM users WHERE username=$1',[username]);
    if (existing) {
     if (existing.role !== 'teacher') throw new Error('A demo teacher username is already assigned to another account. Existing data was preserved.');
     return existing;
    }
    const {rows:[created]}=await tx.query<Row>(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,enabled,account_status) VALUES($1,'teacher',$2,$3,$4,$5,NULL,TRUE,'active') RETURNING *`,[randomUUID(),first,last,username,hash]);
    return created;
   }
   async function classroom(owner:Row,name:string,period:string,code:string,primary=false) {
    let row:Row|undefined;
    if (primary && owner.classroom_id) {
     row=(await tx.query<Row>('SELECT * FROM classrooms WHERE id=$1 AND teacher_id=$2',[owner.classroom_id,owner.id])).rows[0];
    }
    if (!row) row=(await tx.query<Row>('SELECT * FROM classrooms WHERE teacher_id=$1 AND (code=$2 OR (name=$3 AND period=$4)) ORDER BY created_at LIMIT 1',[owner.id,code,name,period])).rows[0];
    if (row && row.code == null && row.legacy_code === 'BIO2026' && row.name === 'AP Biology · Period 2') {
     row=(await tx.query<Row>('UPDATE classrooms SET code=$1,period=COALESCE(period,$2) WHERE id=$3 RETURNING *',[code,period,row.id])).rows[0];
    }
    if (!row) row=(await tx.query<Row>('INSERT INTO classrooms(id,teacher_id,name,period,code) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),owner.id,name,period,code])).rows[0];
    if (primary && !owner.classroom_id) await tx.query('UPDATE users SET classroom_id=$1 WHERE id=$2',[row.id,owner.id]);
    const {rows:[count]}=await tx.query<{n:string}>('SELECT COUNT(*) AS n FROM questions WHERE classroom_id=$1',[row.id]);
    if (Number(count.n)===0) for (const q of defaultQuestions) await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),row.id,q.prompt,JSON.stringify(q.options),q.correctIndex,q.topic,q.explanation,q.active]);
    return row;
   }
   async function students(classroomId:unknown,names:string[][],hash=studentHash) {
    for (const [first,last] of names) {
     const username=`${first}${last}`.toLowerCase();
     const {rows:[existing]}=await tx.query<Row>('SELECT * FROM users WHERE username=$1',[username]);
     if (existing) {
      // Do not undo an existing transfer, removal, password change, or disable.
      if (existing.role==='student' && existing.classroom_id===classroomId) await enroll(tx,existing.id,classroomId);
      continue;
     }
     const id=randomUUID();
     await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,account_status) VALUES($1,'student',$2,$3,$4,$5,$6,'active')`,[id,first,last,username,hash,classroomId]);
     await enroll(tx,id,classroomId);
     // Only new sample trips receive a purpose; historical trips remain intact.
     if (first !== 'Jamie') await tx.query(`INSERT INTO visits(id,classroom_id,student_id,status,purpose,requested_at,ready_at,left_at,returned_at) VALUES($1,$2,$3,'returned',$4,CURRENT_TIMESTAMP-INTERVAL '42 minutes',CURRENT_TIMESTAMP-INTERVAL '42 minutes',CURRENT_TIMESTAMP-INTERVAL '41 minutes',CURRENT_TIMESTAMP-INTERVAL '37 minutes')`,[randomUUID(),classroomId,id,first.length%2===0?'water':'restroom']);
    }
   }
   const demoTeacher=await teacher('Demo','Teacher','teachertest',demoHash);
   const demoClass=await classroom(demoTeacher,'Demo Biology','Demo','DEMO1',true);
   await students(demoClass.id,[['Test','Student']],demoHash);
   const morgan=await teacher('Morgan','Reed','morganreed');
   const maria=await teacher('Maria','Miller','mariamiller');
   const first=await classroom(morgan,'AP Biology · Period 2','2','01001',true);
   const second=await classroom(morgan,'Biology · Period 1','1','01002');
   const third=await classroom(maria,'Honors Biology · Period 3','3','02001',true);
   const fourth=await classroom(maria,'Biology · Period 4','4','02002');
   await students(first.id,[['Jamie','Chen'],['Alex','Rivera'],['Sam','Patel'],['Jordan','Lee'],['Taylor','Brooks'],['Avery','Williams'],['Riley','Johnson'],['Casey','Nguyen'],['Quinn','Davis'],['Emerson','Garcia'],['Charlie','Wilson'],['Dakota','Martinez']]);
   await students(second.id,[['Liam','Wright'],['Zoe','Adams']]);
   await students(third.id,[['Noah','Kim'],['Maya','Robinson']]);
   await students(fourth.id,[['Elena','Torres'],['Owen','Clark']]);
  });
  console.log('Local demo prepared: teachertest and active teststudent in class DEMO1, plus legacy sample classes and biology banks. Existing records, account statuses, and credentials were preserved.');
  const status=await bootstrapDevelopmentAdministrator(db,developmentAdminSecret(process.env));
  if(status==='missing-secret')console.warn('Developer account not initialized: configure the private Codespaces secret DEV_ADMIN_INITIAL_PASSWORD (or ADMIN_INITIAL_PASSWORD), restart the Codespace, then run npm run dev. Student and teacher demos are ready; no privileged password was invented. See README.md and npm run dev:check.');
  else if(status==='legacy-account')console.warn('Existing local administrator has a different username and was preserved. Existing local access still works. Choose a new LOCAL_DATABASE_PATH for the required fresh Developer account; no account was renamed or added.');
  else console.log(status==='created'?'Development Developer account initialized securely from the private secret.':'Existing Developer account and password preserved. Use npm run dev:check to verify the configured secret.');
 } finally {await db.close();}
}
async function enroll(tx:SQL,studentId:unknown,classroomId:unknown) {
 await tx.query('INSERT INTO enrollments(id,student_id,classroom_id,active) VALUES($1,$2,$3,TRUE) ON CONFLICT(student_id,classroom_id) DO NOTHING',[randomUUID(),studentId,classroomId]);
}
seed().catch(error=>{console.error(error instanceof Error?error.message:'Development initialization failed.');process.exitCode=error instanceof LocalDatabaseBusyError?75:1;});
