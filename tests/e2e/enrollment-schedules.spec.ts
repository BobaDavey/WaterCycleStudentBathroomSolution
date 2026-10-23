import {test,expect,type Page} from './fixtures';
import {continueRegistration,joinClass,scheduleClassForm} from './enrollment-helpers';
import type {StudentState,TeacherState} from '../../src/lib/contracts';
const headers={Origin:'http://127.0.0.1:3100','Content-Type':'application/json'};
async function login(page:Page,username='teachertest',password='1234567890',teacher=true){await page.goto('/');await page.getByRole('button',{name:teacher?'I’m a teacher':'I’m a student',exact:true}).click();await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}
async function register(page:Page,first:string,last:string){await page.goto('/');await page.getByRole('button',{name:'Create a student account',exact:true}).click();await expect(page.getByLabel('Username',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Classroom code',{exact:true})).toHaveCount(0);await page.getByLabel('First name',{exact:true}).fill(first);await page.getByLabel('Last name',{exact:true}).fill(last);await page.getByLabel('Password',{exact:true}).fill('BrowserStudent2026!');await page.getByRole('button',{name:'Create my account',exact:true}).click();return continueRegistration(page);}

test('assigned usernames, empty My Classes and two class-specific approvals work through the visible portals',async({browser})=>{
 test.setTimeout(120000);const tc=await browser.newContext(),sc=await browser.newContext({viewport:{width:390,height:844}}),duplicate=await browser.newContext();
 try{
  const teacher=await tc.newPage(),student=await sc.newPage(),second=await duplicate.newPage();await login(teacher);
  const last=`Duplicate${Date.now()}`;const firstUsername=await register(student,'Alex',last),secondUsername=await register(second,'Alex',last);
  expect(firstUsername).toBe(`alex${last.toLowerCase()}01`);expect(secondUsername).toBe(`alex${last.toLowerCase()}02`);
  await expect(student.getByText("You haven't joined a class yet.",{exact:true})).toBeVisible();
  await joinClass(student,'demo1');await joinClass(student,'demo2');
  const myClasses=student.getByRole('region',{name:'My Classes',exact:true});await expect(myClasses.getByText('Pending Approval',{exact:true})).toHaveCount(2);
  await expect(myClasses).toContainText('Demo Biology Morning');await expect(myClasses).toContainText('Demo Chemistry Afternoon');await expect(myClasses).toContainText('Monday–Friday');await expect(myClasses).toContainText('7:00 AM – 1:00 PM');
  const state=await(await student.request.get('/api/student/state')).json() as StudentState;
  const pending=teacher.getByRole('region',{name:/Pending Student Approvals/});const rows=pending.getByRole('row').filter({hasText:firstUsername});await expect(rows).toHaveCount(2);
  // Approve Chemistry while Biology remains Pending, even if another class is selected.
  await rows.filter({hasText:'Demo Chemistry Afternoon'}).getByRole('button',{name:'Approve',exact:true}).click();
  await expect(myClasses.getByText('Approved',{exact:true})).toHaveCount(1);await expect(myClasses.getByText('Pending Approval',{exact:true})).toHaveCount(1);
  const updated=await(await student.request.get('/api/student/state')).json() as StudentState;expect(updated.enrollments.find(e=>e.classroom.code==='DEMO1')?.status).toBe('pending');expect(updated.enrollments.find(e=>e.classroom.code==='DEMO2')?.status).toBe('approved');
  await rows.filter({hasText:'Demo Biology Morning'}).getByRole('button',{name:'Approve',exact:true}).click();await expect(myClasses.getByText('Approved',{exact:true})).toHaveCount(2);
  expect(await student.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await student.screenshot({path:'/tmp/watercycle-my-classes-mobile.png',fullPage:true});
  expect((await student.request.get('/api/admin/state')).status()).toBe(403);expect(state.user.username).toBe(firstUsername);
 }finally{await tc.close();await sc.close();await duplicate.close();}
});

test('teacher schedules, multiple teachers, overlapping class selection, and closed-session handling preserve live breaks',async({browser})=>{
 test.setTimeout(120000);const tc=await browser.newContext(),oc=await browser.newContext(),sc=await browser.newContext({timezoneId:'Asia/Tokyo'});
 try{
  const teacher=await tc.newPage(),other=await oc.newPage(),student=await sc.newPage();await login(teacher);await login(other,'morganreed','WaterCycle2026!');
  await teacher.getByRole('button',{name:'Class Roster',exact:true}).click();await teacher.getByRole('button',{name:'Create Class',exact:true}).click();const dialog=teacher.getByRole('dialog');await dialog.getByLabel('Class name',{exact:true}).fill('Scheduled browser biology');await dialog.getByLabel('Enrollment code',{exact:true}).fill('NEW01');await expect(dialog.getByLabel('Class timezone',{exact:true})).toHaveValue('America/New_York');await scheduleClassForm(teacher);await expect(dialog).toContainText('Monday–Friday');await dialog.getByRole('button',{name:'Create Class',exact:true}).click();await expect(dialog).not.toBeVisible();
  const own=(await(await teacher.request.get('/api/teacher/state')).json() as TeacherState).classes.find(c=>c.code==='NEW01')!;
  const response=await other.request.post('/api/teacher/classes',{headers,data:{name:'Other teacher overlap',code:'NEW02',startTime:'00:00',endTime:'23:59'}});expect(response.ok()).toBe(true);const foreign=(await response.json()).classroom;
  await register(student,'Multi',`Teacher${Date.now()}`);await joinClass(student,'new01');await joinClass(student,'new02');const learner=(await(await student.request.get('/api/student/state')).json() as StudentState).user;
  expect((await teacher.request.patch(`/api/teacher/roster/${learner.id}?classroomId=${foreign.id}`,{headers,data:{accountStatus:'active'}})).status()).toBe(404);
  expect((await teacher.request.patch(`/api/teacher/roster/${learner.id}?classroomId=${own.id}`,{headers,data:{accountStatus:'active'}})).ok()).toBe(true);expect((await other.request.patch(`/api/teacher/roster/${learner.id}?classroomId=${foreign.id}`,{headers,data:{accountStatus:'active'}})).ok()).toBe(true);
  await expect(student.getByText('In session · Breaks available',{exact:true})).toHaveCount(2);
  await student.getByRole('button',{name:'Request a Break',exact:true}).click();await expect(student.getByLabel('Break class',{exact:true})).toBeVisible();await student.getByRole('radio',{name:'Use Restroom',exact:true}).check();await expect(student.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();await student.getByRole('button',{name:'Back to dashboard',exact:true}).click();
  const questions=(await(await other.request.get(`/api/teacher/state?classroomId=${foreign.id}`)).json() as TeacherState).questions;
  await student.getByRole('button',{name:'Request a Break',exact:true}).click();await student.getByLabel('Break class',{exact:true}).selectOption(foreign.id);await student.getByRole('radio',{name:'Use Restroom',exact:true}).check();const started=student.waitForResponse(r=>r.url().endsWith('/api/student/quiz')&&r.request().method()==='POST');await student.getByRole('button',{name:'Continue',exact:true}).click();const quiz=await(await started).json();
  const {answerCurrent}=await import('./break-helpers');const first=await answerCurrent(student,quiz,questions);await student.getByRole('button',{name:'Next question',exact:true}).click();const result=await answerCurrent(student,first.quiz!,questions);expect(result.visit?.classroomId).toBe(foreign.id);const visit=result.visit!;
  // Closing the class never stops an existing outside timer or hides return.
  const now=new Date((await(await student.request.get('/api/student/state')).json()).serverNow);const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  if(clock>'00:00')expect((await other.request.patch(`/api/teacher/classes/${foreign.id}`,{headers,data:{startTime:'00:00',endTime:clock}})).ok()).toBe(true);
  else expect((await other.request.patch(`/api/teacher/classes/${foreign.id}`,{headers,data:{startTime:'01:00',endTime:'02:00'}})).ok()).toBe(true);
  await expect(student.getByRole('button',{name:"I'm Back",exact:true})).toBeVisible();const active=(await(await student.request.get('/api/student/state')).json() as StudentState).currentVisit!;expect(active.id).toBe(visit.id);expect(active.leftAt).toBe(visit.leftAt);
  await student.getByRole('button',{name:"I'm Back",exact:true}).click();expect((await student.request.post('/api/student/quiz',{headers,data:{purpose:'water',classroomId:foreign.id}})).status()).toBe(409);
  expect((await teacher.request.get(`/api/teacher/roster/${learner.id}?classroomId=${foreign.id}`)).status()).toBe(404);
 }finally{await tc.close();await oc.close();await sc.close();}
});
