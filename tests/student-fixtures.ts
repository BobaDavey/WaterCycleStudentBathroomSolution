import type { Database } from '../src/lib/db';
import { WaterCycle } from '../src/lib/domain';
import type { User } from '../src/lib/contracts';
import { userFrom } from '../src/lib/auth';
// Existing regression scenarios are scheduled on a fixed school day. The
// public registration/session behavior is covered directly in enrollment-schedules.
export class WorkflowTestApp extends WaterCycle {
 constructor(db:Database){super(db,()=>new Date('2026-07-01T16:00:00Z'));}
 override createClass(user:User,input:Omit<Parameters<WaterCycle['createClass']>[1],'startTime'|'endTime'>&{startTime?:string;endTime?:string}){return super.createClass(user,{startTime:'00:00',endTime:'23:59',...input});}
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
