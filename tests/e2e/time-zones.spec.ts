import { test,expect, type Page } from '@playwright/test';
import { US_TIME_ZONES, classDateKey, formatClassTimestamp } from '../../src/lib/time-zones';
import type { StudentState,TeacherState } from '../../src/lib/contracts';
import { qualifyBreak } from './break-helpers';
const headers={Origin:'http://127.0.0.1:3100','Content-Type':'application/json'};
async function teacherLogin(page:Page){
 await page.goto('/');await page.getByRole('button',{name:'I’m a teacher',exact:true}).click();
 await page.getByLabel('Username',{exact:true}).fill('teachertest');await page.getByLabel('Password',{exact:true}).fill('1234567890');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}
test('create/edit menus save all seven U.S. zones in order, default Eastern, and retain existing non-U.S. preferences',async({page})=>{
 test.setTimeout(120000);await teacherLogin(page);await page.getByRole('button',{name:'Class Roster',exact:true}).click();
 for(const [index,zone] of US_TIME_ZONES.entries()){
  await page.getByRole('button',{name:'Create Class',exact:true}).click();let dialog=page.getByRole('dialog');
  const select=dialog.getByLabel('Class timezone',{exact:true});
  await expect(select).toHaveValue('America/New_York');
  expect(await select.locator('option').allTextContents()).toEqual(US_TIME_ZONES.map(item=>item.label));
  await dialog.getByLabel('Class name',{exact:true}).fill(`US time zone ${index}`);await dialog.getByLabel('Enrollment code',{exact:true}).fill(`TZ00${index}`);
  await select.selectOption(zone.value);await dialog.getByRole('button',{name:'Create Class',exact:true}).click();await expect(dialog).not.toBeVisible();
  const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:`US time zone ${index}`,exact:true})});
  await card.getByRole('button',{name:'Edit Class',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Class timezone',{exact:true})).toHaveValue(zone.value);
  const next=US_TIME_ZONES[(index+1)%US_TIME_ZONES.length];await dialog.getByLabel('Class timezone',{exact:true}).selectOption(next.value);
  await dialog.getByRole('button',{name:'Save Class',exact:true}).click();await expect(dialog).not.toBeVisible();
  await card.getByRole('button',{name:'Edit Class',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Class timezone',{exact:true})).toHaveValue(next.value);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 }
 const created=await page.request.post('/api/teacher/classes',{headers,data:{name:'Existing London zone',code:'TZOLD',timeZone:'Europe/London'}});expect(created.ok()).toBe(true);
 await page.reload();await page.getByRole('button',{name:'Class Roster',exact:true}).click();
 const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Existing London zone',exact:true})});
 await card.getByRole('button',{name:'Edit Class',exact:true}).click();const dialog=page.getByRole('dialog');
 await expect(dialog.getByLabel('Class timezone',{exact:true})).toHaveValue('Europe/London');await dialog.getByLabel('Class period',{exact:true}).fill('9');
 await dialog.getByRole('button',{name:'Save Class',exact:true}).click();await expect(dialog).not.toBeVisible();
 const state=await(await page.request.get('/api/teacher/state')).json() as TeacherState;
 expect(state.classes.find(item=>item.code==='TZOLD')?.timeZone).toBe('Europe/London');
});

test('class-local registrations, live break clocks, date filters and 24px Overview gaps work independently of browser timezone',async({browser})=>{
 test.setTimeout(120000);
 const teacherContext=await browser.newContext({timezoneId:'Asia/Tokyo',locale:'en-US'}),studentContext=await browser.newContext({timezoneId:'Asia/Tokyo',locale:'en-US'});
 try{
  const page=await teacherContext.newPage();await teacherLogin(page);
  const created=await page.request.post('/api/teacher/classes',{headers,data:{name:'Pacific browser class',code:'TZACT',timeZone:'America/Los_Angeles'}});expect(created.ok()).toBe(true);
  const classroom=(await created.json()).classroom;
  const lastName=`Learner${Date.now()}`;
  const signup=await studentContext.request.post('/api/auth/signup',{headers,data:{firstName:'Timezone',lastName,password:'DevelopmentTimezone2026!',classroomCode:'TZACT'}});expect(signup.ok()).toBe(true);
  const user=(await signup.json()).user;
  const state=await(await page.request.get('/api/teacher/state')).json() as TeacherState;
  const pending=state.pendingStudents.find(item=>item.id===user.id)!;
  const region=page.getByRole('region',{name:/Pending Student Approvals/});const row=region.getByRole('row').filter({hasText:user.username});
  await expect(row).toContainText(formatClassTimestamp(pending.registeredAt,'America/Los_Angeles',undefined,'en-US'));
  for(const [name,width,height] of [['desktop',1440,1100],['tablet',900,1200],['mobile',390,844]] as const){
   await page.setViewportSize({width,height});
   const pendingBox=(await region.boundingBox())!,stats=(await page.getByRole('region',{name:'Classroom statistics',exact:true}).boundingBox())!;
   const flow=(await page.getByRole('region',{name:'Live classroom overview',exact:true}).boundingBox())!;
   const recent=(await page.getByRole('region',{name:'Recent classroom activity',exact:true}).boundingBox())!;
   expect(stats.y-pendingBox.y-pendingBox.height).toBeCloseTo(24,0);expect(flow.y-stats.y-stats.height).toBeCloseTo(24,0);expect(recent.y-flow.y-flow.height).toBeCloseTo(24,0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
   await page.screenshot({path:`/tmp/watercycle-overview-${name}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1100});
  expect((await page.request.patch(`/api/teacher/roster/${user.id}`,{headers,data:{accountStatus:'active'}})).ok()).toBe(true);
  await studentContext.request.post('/api/student/tutorial',{headers,data:{}});
  const student=await studentContext.newPage();await student.goto('/');
  const questions=(await(await page.request.get(`/api/teacher/state?classroomId=${classroom.id}`)).json() as TeacherState).questions;
  const visit=await qualifyBreak(student,questions,'restroom');
  const stamp=(zone:string)=>formatClassTimestamp(visit.leftAt,zone,{hour:'numeric',minute:'2-digit'},'en-US');
  await expect(student.getByText(/^ELAPSED BREAK TIME · STARTED /)).toContainText(stamp('America/Los_Angeles'));
  expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{timeZone:'Pacific/Honolulu'}})).ok()).toBe(true);
  await expect(student.getByText(/^ELAPSED BREAK TIME · STARTED /)).toContainText(stamp('Pacific/Honolulu'));
  const updated=await(await student.request.get('/api/student/state')).json() as StudentState;
  expect(updated.classroom?.timeZone).toBe('Pacific/Honolulu');expect(updated.currentVisit?.leftAt).toBe(visit.leftAt);expect(updated.currentVisit?.id).toBe(visit.id);expect(updated.currentVisit?.status).toBe('out');
  await student.getByRole('button',{name:"I'm Back",exact:true}).click();
  await student.getByRole('button',{name:'My activity',exact:true}).click();
  await expect(student.locator('tbody tr').first()).toContainText(stamp('Pacific/Honolulu'));
  await page.getByLabel('Selected class',{exact:true}).selectOption(classroom.id);await page.getByRole('button',{name:'Trip history',exact:true}).click();
  await page.getByLabel('Filter by date',{exact:true}).fill(classDateKey(visit.requestedAt,'Pacific/Honolulu'));
  await expect(page.getByRole('row').filter({hasText:`Timezone ${lastName}`})).toBeVisible();
 }finally{await teacherContext.close();await studentContext.close();}
});
