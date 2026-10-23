import { test,expect } from '@playwright/test';
import type { TeacherState, StudentState } from '../../src/lib/contracts';
import { qualifyBreak } from './break-helpers';

test('exact fresh-development teacher and Active student credentials support roster visibility and a complete break',async({browser})=>{
 const teacherContext=await browser.newContext();const studentContext=await browser.newContext();
 try{
  const teacher=await teacherContext.newPage();const student=await studentContext.newPage();
  for(const [page,username,isTeacher] of [[teacher,'teachertest',true],[student,'teststudent',false]] as const){
   await page.goto('/');await page.getByRole('button',{name:isTeacher?'I’m a teacher':'I’m a student',exact:true}).click();
   await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill('1234567890');
   await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  const roster=await(await teacher.request.get('/api/teacher/state')).json() as TeacherState;
  const state=await(await student.request.get('/api/student/state')).json() as StudentState;
  expect(state.user.accountStatus).toBe('active');expect(state.classroom?.code).toBe('DEMO1');
  expect(roster.students.find(s=>s.username==='teststudent')?.id).toBe(state.user.id);
  await teacher.getByRole('button',{name:'Class Roster',exact:true}).click();await teacher.getByRole('button',{name:'View Class',exact:true}).click();
  await expect(teacher.getByRole('row').filter({hasText:'teststudent'})).toBeVisible();
  await qualifyBreak(student,roster.questions,'water');
  await expect(student.getByRole('button',{name:"I'm Back",exact:true})).toBeVisible();await student.getByRole('button',{name:"I'm Back",exact:true}).click();
  await expect(student.getByRole('button',{name:'Request a Break',exact:true})).toBeVisible();
  expect((await student.request.get('/api/admin/state')).status()).toBe(403);
  expect((await teacher.request.get('/api/admin/state')).status()).toBe(403);
 }finally{await teacherContext.close();await studentContext.close();}
});
