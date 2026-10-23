import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import { userFrom } from '../src/lib/auth';
import { WaterCycle, classroomFrom } from '../src/lib/domain';
import type { User } from '../src/lib/contracts';
import { DEFAULT_TIME_ZONE, US_TIME_ZONES, effectiveTimeZone, formatClassTimestamp, classDateKey } from '../src/lib/time-zones';
import { duration } from '../src/lib/client';
import { approveStudent } from './student-fixtures';

test('seven U.S. zones use the requested order and Eastern defaults without replacing valid existing preferences',()=>{
 assert.deepEqual(US_TIME_ZONES.map(zone=>zone.value),['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage','Pacific/Honolulu','America/Phoenix']);
 assert.equal(US_TIME_ZONES[0].label,'USA / Eastern (Default)');
 for(const missing of [undefined,null,''])assert.equal(effectiveTimeZone(missing),DEFAULT_TIME_ZONE);
 assert.equal(effectiveTimeZone('Europe/London'),'Europe/London');
 for(const time_zone of [undefined,null,''])assert.equal(classroomFrom({time_zone}).timeZone,DEFAULT_TIME_ZONE);
});
const hours=(value:string,zone:string)=>formatClassTimestamp(value,zone,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'},'en-US');
test('IANA rules apply U.S. daylight saving and keep Hawaii and Arizona on standard time',()=>{
 const winter=['07:00','06:00','05:00','04:00','03:00','02:00','05:00'];
 const summer=['08:00','07:00','06:00','05:00','04:00','02:00','05:00'];
 US_TIME_ZONES.forEach((zone,index)=>{
  assert.equal(hours('2026-01-15T12:00:00Z',zone.value),winter[index]);
  assert.equal(hours('2026-07-15T12:00:00Z',zone.value),summer[index]);
 });
});
test('spring and fall DST transitions change clock display without changing absolute break durations',()=>{
 for(const [start,end,from,to] of [
  ['2026-03-08T06:55:00Z','2026-03-08T07:05:00Z','01:55','03:05'],
  ['2026-11-01T05:55:00Z','2026-11-01T06:05:00Z','01:55','01:05'],
 ]){
  assert.equal(hours(start,DEFAULT_TIME_ZONE),from);assert.equal(hours(end,DEFAULT_TIME_ZONE),to);
  assert.equal(duration(start,end),'10 min');
 }
 assert.equal(classDateKey('2026-07-01T06:30:00Z','America/New_York'),'2026-07-01');
 assert.equal(classDateKey('2026-07-01T06:30:00Z','America/Los_Angeles'),'2026-06-30');
});

describe('Persistent class zones and unchanged absolute classroom records',()=>{
 let db:Database,app:WaterCycle,teacher:User,other:User;
 before(async()=>{
  db=await createDatabase({directory:'memory://'});app=new WaterCycle(db);
  async function owner(username:string){return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES($1,'teacher','Time','Teacher',$2) RETURNING *",[randomUUID(),username])).rows[0]);}
  teacher=await owner('zoneteacher');other=await owner('otherzoneteacher');
 });
 after(async()=>await db.close());
 test('all seven zones save on create/edit, omitted zones default to Eastern, and edits preserve existing preferences',async()=>{
  const primary=await app.createClass(teacher,{name:'Default zone',code:'ZON00'});assert.equal(primary.timeZone,DEFAULT_TIME_ZONE);
  for(const [index,zone] of US_TIME_ZONES.entries()){
   const classroom=await app.createClass(teacher,{name:zone.label,code:`ZON0${index+1}`,timeZone:zone.value});
   assert.equal(classroom.timeZone,zone.value);
   const edited=await app.updateClass(teacher,classroom.id,{name:zone.label+' updated'});assert.equal(edited.timeZone,zone.value);
   for(const next of US_TIME_ZONES)assert.equal((await app.updateClass(teacher,classroom.id,{timeZone:next.value})).timeZone,next.value);
  }
  const legacy=await app.createClass(teacher,{name:'Existing preference',code:'ZON08',timeZone:'Europe/London'});
  assert.equal((await app.updateClass(teacher,legacy.id,{period:'8'})).timeZone,'Europe/London');
  await assert.rejects(()=>app.updateClass(other,legacy.id,{timeZone:'America/Phoenix'}));
  assert.equal((await db.query('SELECT time_zone FROM classrooms WHERE id=$1',[legacy.id])).rows[0].time_zone,'Europe/London');
 });
 test('zone edits preserve passwords, registrations, passes, reservations, queue order, histories and UTC CSV data',async()=>{
  const classroom=await app.createClass(teacher,{name:'Records',code:'ZREC1'});
  const students:User[]=[];
  for(let index=0;index<4;index++)students.push(await approveStudent(db,app,await app.signup({firstName:'Zone',lastName:'Student'+index,password:'ClassroomOnly2026!',classroomCode:classroom.code!})));
  await app.signup({firstName:'Zone',lastName:'Pending',password:'ClassroomOnly2026!',classroomCode:classroom.code!});
  const values=[['returned',students[0].id],['out',students[1].id],['ready',students[2].id],['waiting',students[3].id]];
  for(const [status,student] of values)await db.query(`INSERT INTO visits(id,classroom_id,student_id,status,purpose,requested_at,ready_at,ready_expires_at,left_at,returned_at)
   VALUES($1,$2,$3,$4,'restroom',statement_timestamp()-INTERVAL '6 minutes',CASE WHEN $4 IN ('ready','out','returned') THEN statement_timestamp()-INTERVAL '5 minutes' END,
    CASE WHEN $4='ready' THEN statement_timestamp()+INTERVAL '1 hour' END,CASE WHEN $4 IN ('returned','out') THEN statement_timestamp()-INTERVAL '4 minutes' END,
    CASE WHEN $4='returned' THEN statement_timestamp()-INTERVAL '1 minute' END)`,[randomUUID(),classroom.id,student,status]);
  async function records(){
   const result:Record<string,unknown>={};
   for(const table of ['users','visits','enrollments','quizzes','questions','student_status_events','sessions','rate_limits','break_corrections'])result[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
   return result;
  }
  const original=await records(),csv=await app.exportCsv(teacher,classroom.id);
  const initial=await app.teacherState(teacher,classroom.id);
  for(const zone of US_TIME_ZONES){
   await app.updateClass(teacher,classroom.id,{timeZone:zone.value});
   const student=await app.studentState(students[1]);
   assert.equal(student.classroom?.timeZone,zone.value);assert.equal(student.currentVisit?.timeZone,zone.value);
   assert.equal(student.activeCount,2);assert.equal(student.waitingCount,1);
   const waiting=await app.studentState(students[3]);assert.equal(waiting.currentVisit?.status,'waiting');assert.equal(waiting.currentVisit.position,1);
   const state=await app.teacherState(teacher,classroom.id);assert.deepEqual(state.stats,initial.stats);
   assert.equal(state.pendingStudents.find(row=>row.username==='zonepending')?.registeredAt,initial.pendingStudents.find(row=>row.username==='zonepending')?.registeredAt);
   assert.equal(await app.exportCsv(teacher,classroom.id),csv);assert.deepEqual(await records(),original);
  }
 });
 test('transferred students retain each historical trip’s original class zone',async()=>{
  const original=await app.createClass(teacher,{name:'Original classroom',code:'ZOLD1',timeZone:'America/Anchorage'});
  const destination=await app.createClass(teacher,{name:'New classroom',code:'ZNEW1',timeZone:'Pacific/Honolulu'});
  const student=await approveStudent(db,app,await app.signup({firstName:'Transferred',lastName:'Zone',password:'ClassroomOnly2026!',classroomCode:original.code!}));
  const id=randomUUID();await db.query("INSERT INTO visits(id,classroom_id,student_id,status,left_at,returned_at) VALUES($1,$2,$3,'returned','2026-07-01T06:30:00Z','2026-07-01T06:35:00Z')",[id,original.id,student.id]);
  await app.transferStudent(teacher,student.id,destination.id);
  const current=userFrom((await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0]);
  const state=await app.studentState(current);assert.equal(state.classroom?.timeZone,'Pacific/Honolulu');
  const trip=state.recentVisits.find(visit=>visit.id===id)!;assert.equal(trip.timeZone,'America/Anchorage');assert.equal(trip.leftAt,'2026-07-01T06:30:00.000Z');
 });
});
