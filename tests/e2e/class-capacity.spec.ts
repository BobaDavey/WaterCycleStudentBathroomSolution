import {test,expect,type Page} from './fixtures';
import type {TeacherState,User} from '../../src/lib/contracts';
import {qualifyBreak} from './break-helpers';
const headers={Origin:'http://127.0.0.1:3100','Content-Type':'application/json'};
async function login(page:Page,username='teachertest',password='1234567890',teacher=true){
 await page.goto('/');await page.getByRole('button',{name:teacher?'I’m a teacher':'I’m a student',exact:true}).click();await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}
test('login copy and classroom capacity editor preserve default, selection, co-teacher permissions and responsive flow spots',async({page,browser})=>{
 test.setTimeout(120000);await page.goto('/');await expect(page.getByText('Make room for curiosity. A thoughtful way to manage bathroom breaks.',{exact:true})).toBeVisible();await expect(page.getByText(/one biology question at a time/)).toHaveCount(0);
 await login(page);await page.getByRole('button',{name:'Class Roster',exact:true}).click();await page.getByRole('button',{name:'Create Class',exact:true}).click();let dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Max Passes Allowed',{exact:true})).toHaveValue('2');
 await dialog.getByLabel('Class name',{exact:true}).fill('Capacity browser class');await dialog.getByLabel('Enrollment code',{exact:true}).fill('BC001');await dialog.getByLabel('Class start time',{exact:true}).fill('00:00');await dialog.getByLabel('Class end time',{exact:true}).fill('23:59');await dialog.getByRole('button',{name:'Create Class',exact:true}).click();await expect(dialog).toHaveCount(0);
 const initial=await(await page.request.get('/api/teacher/state')).json() as TeacherState;const classroom=initial.classes.find(c=>c.code==='BC001')!;expect(classroom.capacity).toBe(2);
 const otherResponse=await page.request.post('/api/teacher/classes',{headers,data:{name:'Independent capacity class',code:'BC002',startTime:'00:00',endTime:'23:59',capacity:5}});expect(otherResponse.ok()).toBe(true);const other=(await otherResponse.json()).classroom;
 for(const capacity of [1,2,3,5]){
  await page.getByRole('button',{name:'Class Roster',exact:true}).click();await page.locator(`[data-classroom-id="${classroom.id}"]`).getByRole('button',{name:'View Class',exact:true}).click();await page.getByRole('button',{name:'Edit Class',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByLabel('Max Passes Allowed',{exact:true}).fill(String(capacity));await dialog.getByRole('button',{name:'Save Class',exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'Overview',exact:true}).click();const spots=page.getByRole('group',{name:'Classroom pass spots',exact:true});await expect(spots.locator(':scope > div')).toHaveCount(capacity);await expect(page.getByText(`${capacity} ${capacity===1?'spot':'spots'}. One smooth-moving classroom.`,{exact:true})).toBeVisible();
  for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);const bounds=await spots.boundingBox();expect(bounds!.width).toBeGreaterThan(0);}
  await page.setViewportSize({width:1440,height:1000});
 }
 await page.reload();await page.getByLabel('Selected class',{exact:true}).selectOption(classroom.id);await expect(page.getByRole('group',{name:'Classroom pass spots',exact:true}).locator(':scope > div')).toHaveCount(5);
 await page.getByLabel('Selected class',{exact:true}).selectOption(other.id);await expect(page.getByRole('group',{name:'Classroom pass spots',exact:true}).locator(':scope > div')).toHaveCount(5);
 expect((await page.request.post(`/api/teacher/classes/${classroom.id}/teachers`,{headers,data:{username:'mariamiller'}})).ok()).toBe(true);
 const context=await browser.newContext();try{
  const co=await context.newPage();await login(co,'mariamiller','WaterCycle2026!');await co.getByLabel('Selected class',{exact:true}).selectOption(classroom.id);await co.getByRole('button',{name:'Class Roster',exact:true}).click();await co.locator(`[data-classroom-id="${classroom.id}"]`).getByRole('button',{name:'View Class',exact:true}).click();await co.getByRole('button',{name:'Edit Class',exact:true}).click();const form=co.getByRole('dialog');await expect(form.getByLabel('Max Passes Allowed',{exact:true})).toHaveValue('5');await form.getByLabel('Max Passes Allowed',{exact:true}).fill('3');await form.getByRole('button',{name:'Save Class',exact:true}).click();await expect(form).toHaveCount(0);
  const state=await(await co.request.get(`/api/teacher/state?classroomId=${classroom.id}`)).json() as TeacherState;expect(state.classroom?.capacity).toBe(3);expect(state.classes.find(c=>c.id===other.id)).toBeUndefined();
 }finally{await context.close();}
 await page.getByLabel('Selected class',{exact:true}).selectOption(classroom.id);await expect(page.getByRole('group',{name:'Classroom pass spots',exact:true}).locator(':scope > div')).toHaveCount(3);
 expect((await(await page.request.get(`/api/teacher/state?classroomId=${other.id}`)).json()).classroom.capacity).toBe(5);
 expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:0}})).status()).toBe(400);expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:1.5}})).status()).toBe(400);expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:31}})).status()).toBe(400);
});

test('student browsers honor a one-pass classroom, wait in line, depart after return and update capacity without resetting a timer',async({page,browser})=>{
 test.setTimeout(120000);await login(page);const response=await page.request.post('/api/teacher/classes',{headers,data:{name:'Student capacity browser',code:'BC003',startTime:'00:00',endTime:'23:59',capacity:1}});expect(response.ok()).toBe(true);const classroom=(await response.json()).classroom;
 const state=await(await page.request.get(`/api/teacher/state?classroomId=${classroom.id}`)).json() as TeacherState;
 const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:390,height:844}})]);
 try{
  const students:Page[]=[];
  for(const [index,context] of contexts.entries()){
   const student=await context.newPage();const signup=await student.request.post('/api/auth/signup',{headers,data:{firstName:'Browsercapacity',lastName:index?'Second':'First',password:'BrowserCapacity2026!'}});expect(signup.ok()).toBe(true);const user=(await signup.json()).user as User;
   expect((await page.request.post(`/api/teacher/roster?classroomId=${classroom.id}`,{headers,data:{username:user.username,studentId:user.id}})).ok()).toBe(true);expect((await student.request.post('/api/student/tutorial',{headers,data:{}})).ok()).toBe(true);await student.request.post('/api/auth/logout',{headers,data:{}});await login(student,user.username,'BrowserCapacity2026!',false);students.push(student);
   await expect(student.getByText('A maximum of 1 student at a time keeps things moving.',{exact:true})).toBeVisible();
  }
  const trip=await qualifyBreak(students[0],state.questions);expect(trip.status).toBe('out');
  expect((await qualifyBreak(students[1],state.questions)).status).toBe('waiting');await expect(students[1].getByRole('heading',{name:"You're in WAITLINE!",exact:true})).toBeVisible();
  expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:2}})).ok()).toBe(true);await expect(students[1].getByRole('button',{name:"I'm Leaving Now",exact:true})).toBeEnabled();await expect(students[1]).toHaveTitle("It's your turn! · WaterCycle");
  expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:1}})).ok()).toBe(true);await expect(students[1].getByRole('heading',{name:'Your place is saved. Please wait for a spot.',exact:true})).toBeVisible();await expect(students[1].getByRole('button',{name:"I'm Leaving Now",exact:true})).toBeDisabled();await expect(students[1]).toHaveTitle('Your place is saved · WaterCycle');
  expect((await students[1].request.post('/api/student/leave',{headers,data:{}})).status()).toBe(409);
  await students[0].getByRole('button',{name:"I'm Back",exact:true}).click();await expect(students[1].getByRole('button',{name:"I'm Leaving Now",exact:true})).toBeEnabled();await expect(students[1]).toHaveTitle("It's your turn! · WaterCycle");await students[1].getByRole('button',{name:"I'm Leaving Now",exact:true}).click();await expect(students[1].getByRole('heading',{name:'Your time is NOW, GRAB A PASS',exact:true})).toBeVisible();
  const before=(await(await students[1].request.get('/api/student/state')).json()).currentVisit;
  expect((await page.request.patch(`/api/teacher/classes/${classroom.id}`,{headers,data:{capacity:5}})).ok()).toBe(true);await expect(students[1].getByText('A maximum of 5 students at a time keeps things moving.',{exact:true})).toBeVisible();
  await students[1].reload();const after=(await(await students[1].request.get('/api/student/state')).json()).currentVisit;expect(after.id).toBe(before.id);expect(after.leftAt).toBe(before.leftAt);expect(await students[1].evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await students[1].getByRole('button',{name:"I'm Back",exact:true}).click();
 }finally{await Promise.all(contexts.map(context=>context.close()));}
});
