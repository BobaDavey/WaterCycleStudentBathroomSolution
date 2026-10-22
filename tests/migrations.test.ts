import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase, type SQL } from '../src/lib/db';
import { baselineSchema, multiTeacherMigration, migrateDatabase } from '../src/lib/migrations';
import { ADMIN_USERNAME, bootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { hashPassword, verifyPassword, userFrom } from '../src/lib/auth';

async function migrateLegacy(db:PGlite) {
 await db.transaction(async tx=>{
  await migrateDatabase({async query<T>(sql:string,params:unknown[]=[]) { const result=await tx.query<T>(sql,params);return {rows:result.rows}; }},async sql=>{await tx.exec(sql);});
 });
}
async function legacy() {
 const db=new PGlite('memory://');
 await db.exec(baselineSchema);
 await db.query("INSERT INTO classrooms(id,name,code) VALUES('legacy-class','Original class','BIO2026')");
 const oldHash=await hashPassword(randomBytes(24).toString('base64url'));
 await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES('legacy-teacher','teacher','Original','Teacher','originalteacher',$1,'legacy-class')",[oldHash]);
 await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES('legacy-student','student','Original','Student','originalstudent',$1,'legacy-class')",[oldHash]);
 await db.query("INSERT INTO visits(id,classroom_id,student_id,status,left_at,returned_at) VALUES('legacy-visit','legacy-class','legacy-student','returned',CURRENT_TIMESTAMP-INTERVAL '5 minutes',CURRENT_TIMESTAMP)");
 await db.query("INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic) VALUES('legacy-question','legacy-class','Original biology question','[\"a\",\"b\",\"c\",\"d\"]',0,'Biology')");
 await db.query("INSERT INTO quizzes(id,student_id,questions,expires_at) VALUES('legacy-quiz','legacy-student','[]',CURRENT_TIMESTAMP+INTERVAL '5 minutes')");
 return {db,oldHash};
}

test('migrates original records and ownership without replacing identities, passwords, or history',async()=>{
 const {db,oldHash}=await legacy();
 try {
  await migrateLegacy(db);
  const classroom=(await db.query<Record<string,unknown>>("SELECT * FROM classrooms WHERE id='legacy-class'")).rows[0];
  assert.equal(classroom.teacher_id,'legacy-teacher'); assert.equal(classroom.code,null);assert.equal(classroom.legacy_code,'BIO2026');
  assert.equal(classroom.archived,false);
  const student=(await db.query<Record<string,unknown>>("SELECT * FROM users WHERE id='legacy-student'")).rows[0];
  assert.equal(student.password_hash,oldHash);assert.equal(student.classroom_id,'legacy-class');
  assert.equal((await db.query("SELECT * FROM visits WHERE id='legacy-visit'")).rows.length,1);
  assert.equal((await db.query("SELECT * FROM questions WHERE id='legacy-question'")).rows.length,1);
  assert.equal((await db.query<{classroom_id:string}>("SELECT classroom_id FROM quizzes WHERE id='legacy-quiz'")).rows[0].classroom_id,'legacy-class');
  assert.deepEqual((await db.query('SELECT student_id,classroom_id,active FROM enrollments')).rows,[{student_id:'legacy-student',classroom_id:'legacy-class',active:true}]);
  await migrateLegacy(db);
  assert.deepEqual((await db.query('SELECT version FROM watercycle_migrations ORDER BY version')).rows,[{version:1},{version:2}]);
  assert.equal((await db.query('SELECT * FROM enrollments')).rows.length,1);
  assert.equal((await db.query('SELECT * FROM visits')).rows.length,1);
  await db.query("UPDATE classrooms SET code='00123' WHERE id='legacy-class'");
  assert.equal((await db.query<{code:string}>('SELECT code FROM classrooms')).rows[0].code,'00123');
 } finally {await db.close();}
});

test('rolls back an ambiguous legacy ownership migration without losing records',async()=>{
 const {db}=await legacy();
 try {
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES('second-teacher','teacher','Second','Teacher','secondteacher','legacy-class')");
  await assert.rejects(migrateLegacy(db),/ownership is missing or ambiguous/);
  assert.equal((await db.query<{n:number}>("SELECT COUNT(*)::int AS n FROM users")).rows[0].n,3);
  assert.equal((await db.query<{code:string}>('SELECT code FROM classrooms')).rows[0].code,'BIO2026');
  assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='classrooms' AND column_name='teacher_id'")).rows.length,0);
  assert.equal((await db.query('SELECT * FROM watercycle_migrations')).rows.length,0);
 } finally {await db.close();}
});

test('database normalizes five-character English alphanumeric codes and enforces active uniqueness',async()=>{
 const db=await createDatabase({directory:'memory://',bootstrapAdmin:false});
 try {
  await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('teacher','teacher','Test','Teacher','codeteacher')");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('one','teacher','First','00123')");
  for (const code of ['ABCDE','BIO01','9ABC2','12345']) await db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)',[randomUUID(),'teacher','Valid',code]);
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('letters','teacher','Letters','ab123')");
  assert.equal((await db.query<{code:string}>("SELECT code FROM classrooms WHERE id='letters'")).rows[0].code,'AB123');
  await db.query("UPDATE classrooms SET code='abC02' WHERE id='letters'");
  assert.equal((await db.query<{code:string}>("SELECT code FROM classrooms WHERE id='letters'")).rows[0].code,'ABC02');
  for (const code of ['1234','123456','12.34',' 1234','AB@12','ß123','İB123','éB123','ＡB123','']) await assert.rejects(db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)',[randomUUID(),'teacher','Invalid',code]));
  await assert.rejects(db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('case-duplicate','teacher','Duplicate','aBc02')"));
  await assert.rejects(db.query("UPDATE classrooms SET code='bIo01' WHERE id='letters'"));
  await assert.rejects(db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('two','teacher','Second','00123')"));
  await assert.rejects(db.query("INSERT INTO classrooms(id,name,code) VALUES('ownerless','No teacher','00999')"));
  await assert.rejects(db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('no-code','teacher','No code',NULL)"));
  await db.query("UPDATE classrooms SET archived=TRUE WHERE id='one'");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('two','teacher','Second','00123')");
  await assert.rejects(db.query("UPDATE classrooms SET archived=FALSE WHERE id='one'"));
  assert.equal((await db.query<{code:string}>("SELECT code FROM classrooms WHERE id='two'")).rows[0].code,'00123');
 } finally {await db.close();}
});

test('version two preserves numeric codes, users, departures, and history while safely upgrading pending work',async()=>{
 const {db,oldHash}=await legacy();
 try {
  // Recreate the previous deployed schema independently of the new migration.
  await db.exec(multiTeacherMigration);
  await db.query('INSERT INTO watercycle_migrations(version) VALUES(1)');
  await db.query("UPDATE classrooms SET code='00123' WHERE id='legacy-class'");
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('existing-admin','admin','Existing','Administrator',$1,$2)",[ADMIN_USERNAME,oldHash]);
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES('ready-student','student','Ready','Student','readystudent','legacy-class'),('waiting-student','student','Waiting','Student','waitingstudent','legacy-class')");
  await db.query("INSERT INTO visits(id,classroom_id,student_id,status,requested_at,ready_at,left_at) VALUES('active-trip','legacy-class','legacy-student','out','2026-01-02T09:00:00Z','2026-01-02T09:01:00Z','2026-01-02T09:02:00Z'),('ready-trip','legacy-class','ready-student','ready','2026-01-02T09:03:00Z','2026-01-02T09:04:00Z',NULL),('waiting-trip','legacy-class','waiting-student','waiting','2026-01-02T09:05:00Z',NULL,NULL)");
  const oldTrips=(await db.query<Record<string,unknown>>('SELECT id,status,requested_at,ready_at,left_at,returned_at FROM visits ORDER BY id')).rows;
  const oldQuiz=(await db.query<Record<string,unknown>>("SELECT * FROM quizzes WHERE id='legacy-quiz'")).rows[0];
  const started=Date.now();
  await migrateLegacy(db);
  const finished=Date.now();
  assert.equal((await db.query<{code:string}>('SELECT code FROM classrooms')).rows[0].code,'00123');
  assert.deepEqual((await db.query('SELECT id,status,requested_at,ready_at,left_at,returned_at FROM visits ORDER BY id')).rows,oldTrips);
  const users=(await db.query<Record<string,unknown>>('SELECT * FROM users')).rows;
  assert.equal(users.length,5);
  assert.ok(users.every(user=>user.tutorial_completed===true));
  assert.equal(users.find(user=>user.id==='legacy-student')?.password_hash,oldHash);
  assert.equal(users.find(user=>user.id==='existing-admin')?.password_hash,oldHash);
  assert.equal(userFrom(users.find(user=>user.id==='legacy-student')!).tutorialCompleted,true);
  const visits=(await db.query<Record<string,unknown>>('SELECT * FROM visits ORDER BY id')).rows;
  assert.ok(visits.every(visit=>visit.purpose===null&&visit.warning_acknowledged_at===null));
  const ready=visits.find(visit=>visit.id==='ready-trip')!;
  const expiry=ready.ready_expires_at instanceof Date?ready.ready_expires_at.getTime():Date.parse(String(ready.ready_expires_at));
  assert.ok(expiry>=started+120000&&expiry<=finished+120000);
  assert.ok(visits.filter(visit=>visit.status!=='ready').every(visit=>visit.ready_expires_at===null));
  const quiz=(await db.query<Record<string,unknown>>("SELECT * FROM quizzes WHERE id='legacy-quiz'")).rows[0];
  assert.equal(quiz.used,true);
  assert.deepEqual(quiz.questions,oldQuiz.questions);
  assert.deepEqual(quiz.expires_at,oldQuiz.expires_at);
  assert.equal(quiz.classroom_id,'legacy-class');
  assert.equal(quiz.purpose,null);assert.equal(quiz.correct_count,0);assert.equal(quiz.current_index,0);
  assert.equal(quiz.question_token,null);assert.equal(quiz.visit_id,null);
  assert.deepEqual(quiz.seen_question_ids,[]);assert.deepEqual(quiz.answer_history,[]);
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,tutorial_completed) VALUES('new-student','student','New','Student','newstudent',FALSE)");
  assert.equal(userFrom((await db.query<Record<string,unknown>>("SELECT * FROM users WHERE id='new-student'")).rows[0]).tutorialCompleted,false);
  await db.query("UPDATE users SET tutorial_completed=TRUE WHERE id='new-student'");
  await db.query("UPDATE visits SET purpose='water',warning_acknowledged_at=CURRENT_TIMESTAMP WHERE id='active-trip'");
  await db.query("INSERT INTO quizzes(id,student_id,classroom_id,questions,expires_at,purpose,correct_count,current_index,question_token,seen_question_ids,answer_history,visit_id) VALUES('new-quiz','new-student','legacy-class','[]',CURRENT_TIMESTAMP+INTERVAL '5 minutes','restroom',1,2,'presentation-token','[\"question-one\"]','[{\"correct\":true}]','active-trip')");
  await migrateLegacy(db);
  assert.deepEqual((await db.query('SELECT version FROM watercycle_migrations ORDER BY version')).rows,[{version:1},{version:2}]);
  assert.deepEqual((await db.query("SELECT ready_expires_at FROM visits WHERE id='ready-trip'")).rows[0].ready_expires_at,ready.ready_expires_at);
  assert.equal((await db.query<{used:boolean}>("SELECT used FROM quizzes WHERE id='new-quiz'")).rows[0].used,false);
  assert.equal((await db.query<{tutorial_completed:boolean}>("SELECT tutorial_completed FROM users WHERE id='new-student'")).rows[0].tutorial_completed,true);
  assert.equal((await db.query<{purpose:string}>("SELECT purpose FROM visits WHERE id='active-trip'")).rows[0].purpose,'water');
  await assert.rejects(db.query("UPDATE users SET enabled=FALSE WHERE id='existing-admin'"));
 } finally {await db.close();}
});

test('database rejects invalid break purposes and impossible cumulative quiz progress',async()=>{
 const db=await createDatabase({directory:'memory://',bootstrapAdmin:false});
 try {
  await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('teacher','teacher','Break','Teacher','breakteacher'),('student','student','Break','Student','breakstudent')");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('class','teacher','Biology','bio01')");
  await db.query("INSERT INTO visits(id,classroom_id,student_id,status,purpose) VALUES('trip','class','student','returned','restroom')");
  await assert.rejects(db.query("UPDATE visits SET purpose='other' WHERE id='trip'"));
  await db.query("INSERT INTO quizzes(id,student_id,classroom_id,questions,expires_at,purpose) VALUES('quiz','student','class','[]',CURRENT_TIMESTAMP+INTERVAL '15 minutes','water')");
  for(const count of [-1,3]) await assert.rejects(db.query("UPDATE quizzes SET correct_count=$1 WHERE id='quiz'",[count]));
  await assert.rejects(db.query("UPDATE quizzes SET current_index=-1 WHERE id='quiz'"));
  await assert.rejects(db.query("UPDATE quizzes SET purpose='other' WHERE id='quiz'"));
  await assert.rejects(db.query("UPDATE quizzes SET visit_id='missing-visit' WHERE id='quiz'"));
  await db.query("UPDATE quizzes SET correct_count=2,current_index=4,visit_id='trip' WHERE id='quiz'");
  assert.deepEqual((await db.query("SELECT purpose,correct_count,current_index,visit_id FROM quizzes WHERE id='quiz'")).rows[0],{purpose:'water',correct_count:2,current_index:4,visit_id:'trip'});
 } finally {await db.close();}
});

test('database prevents duplicate or multiple active student enrollments',async()=>{
 const db=await createDatabase({directory:'memory://',bootstrapAdmin:false});
 try {
  await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('teacher','teacher','Test','Teacher','enrollteacher')");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('one','teacher','First','00123'),('two','teacher','Second','00456')");
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES('student','student','Test','Student','enrollstudent','one')");
  await db.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES('enrollment','student','one')");
  await assert.rejects(db.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES('duplicate','student','one')"));
  await assert.rejects(db.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES('other','student','two')"));
  await db.query("UPDATE enrollments SET active=FALSE,left_at=CURRENT_TIMESTAMP WHERE id='enrollment'");
  await db.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES('other','student','two')");
  assert.equal((await db.query('SELECT * FROM enrollments')).rows.length,2);
 } finally {await db.close();}
});

test('administrator provisioning requires a private secret and never resets an existing password',async()=>{
 const db=await createDatabase({directory:'memory://',bootstrapAdmin:false});
 try {
  assert.equal(await bootstrapAdministrator(db),'missing-secret');
  assert.equal((await db.query("SELECT id FROM users WHERE role='admin'")).rows.length,0);
  const password=randomBytes(30).toString('base64url');
  assert.equal(await bootstrapAdministrator(db,password),'created');
  const admin=(await db.query<Record<string,unknown>>("SELECT * FROM users WHERE role='admin'")).rows[0];
  assert.equal(admin.username,ADMIN_USERNAME);assert.notEqual(admin.password_hash,password);assert.equal(admin.classroom_id,null);
  assert.equal(await verifyPassword(password,String(admin.password_hash)),true);
  assert.equal(await bootstrapAdministrator(db,randomBytes(30).toString('base64url')),'exists');
  assert.equal(await bootstrapAdministrator(db),'exists');
  assert.equal((await db.query<{password_hash:string}>("SELECT password_hash FROM users WHERE role='admin'")).rows[0].password_hash,admin.password_hash);
  assert.equal(userFrom(admin).classroomId,null);
 } finally {await db.close();}
});

test('database keeps exactly one fixed administrator protected from deletion, demotion, renaming, and disable',async()=>{
 const db=await createDatabase({directory:'memory://',bootstrapAdmin:false});
 try {
  const secrets=[randomBytes(30).toString('base64url'),randomBytes(30).toString('base64url')];
  const results=await Promise.all(secrets.map(secret=>bootstrapAdministrator(db,secret)));
  assert.equal(results.filter(result=>result==='created').length,1);
  assert.equal(results.filter(result=>result==='exists').length,1);
  await assert.rejects(db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('second-admin','admin','Second','Admin','anotheradmin')"));
  await assert.rejects(db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('same-admin','admin','Second','Admin',$1)",[ADMIN_USERNAME]));
  for (const sql of ["DELETE FROM users WHERE role='admin'","UPDATE users SET role='teacher' WHERE role='admin'","UPDATE users SET username='changed' WHERE role='admin'","UPDATE users SET enabled=FALSE WHERE role='admin'"]) await assert.rejects(db.query(sql));
  assert.equal((await db.query("SELECT id FROM users WHERE role='admin' AND enabled=TRUE")).rows.length,1);
  await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('ordinary-user','student','Ordinary','Student','ordinarydelete')");
  await db.query("DELETE FROM users WHERE id='ordinary-user'");
  assert.equal((await db.query("SELECT id FROM users WHERE id='ordinary-user'")).rows.length,0);
  await db.query("UPDATE users SET first_name='Updated' WHERE role='admin'");
  assert.equal((await db.query<{first_name:string}>("SELECT first_name FROM users WHERE role='admin'")).rows[0].first_name,'Updated');
 } finally {await db.close();}
});
