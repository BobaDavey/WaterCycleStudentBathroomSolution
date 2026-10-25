import type { Database } from '../src/lib/db';
import { WaterCycle } from '../src/lib/domain';
import type { User } from '../src/lib/contracts';
import {randomUUID} from 'node:crypto';
import { userFrom,usernameFor } from '../src/lib/auth';
// Existing regression scenarios are scheduled on a fixed school day. The
// public registration/session behavior is covered directly in enrollment-schedules.
export class WorkflowTestApp extends WaterCycle {
 constructor(db:Database){super(db,()=>new Date('2026-07-01T16:00:00Z'));}
 override createClass(user:User,input:Omit<Parameters<WaterCycle['createClass']>[1],'startTime'|'endTime'>&{startTime?:string;endTime?:string}){return super.createClass(user,{startTime:'00:00',endTime:'23:59',...input});}
 // Retained unregistered accounts exercise pre-existing records only. The public API no longer creates these.
 override async addRoster(user:User,input:Parameters<WaterCycle['addRoster']>[1]|{firstName:string;lastName:string},classroomId?:string){
  if('username' in input)return super.addRoster(user,input,classroomId);
  const state=await this.teacherState(user,classroomId);if(!state.classroom)throw new Error('Fixture classroom missing.');
  const id=randomUUID(),username=usernameFor(input.firstName,input.lastName)+String((await this.db.query('SELECT COUNT(*) AS n FROM users')).rows[0].n).padStart(2,'0');
  await this.db.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id,tutorial_completed) VALUES($1,'student',$2,$3,$4,$5,FALSE)",[id,input.firstName,input.lastName,username,state.classroom.id]);
  await this.db.query('INSERT INTO enrollments(id,student_id,classroom_id) VALUES($1,$2,$3)',[randomUUID(),id,state.classroom.id]);
  return{id,username,firstName:input.firstName,lastName:input.lastName,registered:false} as Awaited<ReturnType<WaterCycle['addRoster']>>;
 }
 override async signup(input:Parameters<WaterCycle['signup']>[0]&{classroomCode?:string;username?:string}){
  const student=await super.signup(input);
  if(input.classroomCode)await this.enrollStudent(student,input.classroomCode);
  return userFrom((await this.db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0]);
 }
}
export async function approveStudent(db:Database,app:WaterCycle,student:User):Promise<User> {
 const {rows:[owner]}=await db.query('SELECT t.*,e.classroom_id AS enrollment_class FROM users t JOIN classrooms c ON c.teacher_id=t.id JOIN enrollments e ON e.classroom_id=c.id WHERE e.student_id=$1 AND e.active=TRUE ORDER BY e.joined_at DESC LIMIT 1',[student.id]);
 await app.updateRoster(userFrom(owner),student.id,{accountStatus:'active'},String(owner.enrollment_class));
 return userFrom((await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0]);
}
