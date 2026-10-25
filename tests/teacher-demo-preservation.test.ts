import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/lib/db';
import {WaterCycle} from '../src/lib/domain';
import {userFrom} from '../src/lib/auth';

test('repeated isolated demo setup preserves unassigned questions and intentionally inactive sets',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'watercycle-teacher-demo-')),directory=path.join(root,'data');
 const env:NodeJS.ProcessEnv={...process.env,CODESPACES:'false',NODE_ENV:'development',VERCEL:'0',VERCEL_ENV:'development',WATERCYCLE_ENVIRONMENT:'development',WATERCYCLE_DATABASE_ID:'',DATABASE_URL:'',MIGRATION_DATABASE_URL:'',ADMIN_INITIAL_PASSWORD:'',DEV_ADMIN_INITIAL_PASSWORD:'',LOCAL_DATABASE:'true',DEMO_MODE:'true',LOCAL_DATABASE_PATH:directory};
 async function seed(){const child=spawn(process.execPath,['--import','tsx','scripts/seed.ts'],{env,stdio:'ignore'});assert.equal(await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('exit',resolve);}),0);}
 try{
  await seed();let db=await createDatabase({directory});let questionId='',classroomId='';let before:unknown;
  try{const app=new WaterCycle(db),teacher=userFrom((await db.query("SELECT * FROM users WHERE username='teachertest'")).rows[0]);classroomId=String((await db.query("SELECT id FROM classrooms WHERE code='DEMO1'")).rows[0].id);
   const question=await app.saveQuestion(teacher,{prompt:'Independent demo question that stays unassigned?',options:['One','Two','Three','Four'],correctIndex:0,topic:'Ecology',explanation:'',active:true,setIds:[]},undefined,classroomId);questionId=question!.id;
   await app.setActiveQuestionSets(teacher,classroomId,[]);before=(await db.query('SELECT * FROM questions WHERE id=$1',[questionId])).rows;
  }finally{await db.close();}
  await seed();db=await createDatabase({directory});try{
   assert.deepEqual((await db.query('SELECT * FROM questions WHERE id=$1',[questionId])).rows,before);
   assert.equal((await db.query('SELECT 1 FROM question_set_questions WHERE question_id=$1 AND active=TRUE',[questionId])).rows.length,0);
   assert.equal((await db.query('SELECT 1 FROM classroom_question_sets WHERE classroom_id=$1 AND active=TRUE',[classroomId])).rows.length,0);
  }finally{await db.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
