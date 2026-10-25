import type {SQL} from './db';
import type {User} from './contracts';
import {AppError} from './auth';

/** Identifiers/parameters are source-code constants, never request input. */
export function classroomScope(alias='c',parameter='$2') {
 return `(${alias}.teacher_id=${parameter} OR EXISTS(SELECT 1 FROM classroom_teachers ct WHERE ct.classroom_id=${alias}.id AND ct.teacher_id=${parameter} AND ct.active=TRUE))`;
}
/** Lock the class before checking membership: removal serializes with mutations. */
export async function assertClassroomTeacher(tx:SQL,user:User,id:string,primaryOnly=false) {
 if(user.role!=='teacher')throw new AppError(403,'Teacher access required.');
 const {rows:[classroom]}=await tx.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE',[id]);
 if(!classroom)throw new AppError(404,'Class not found.');
 const {rows:[actor]}=await tx.query("SELECT enabled,must_change_password FROM users WHERE id=$1 AND role='teacher'",[user.id]);
 if(!actor?.enabled||actor.must_change_password)throw new AppError(403,'Your teacher account is unavailable or requires a password change.');
 if(primaryOnly){if(classroom.teacher_id!==user.id)throw new AppError(403,'Only the Primary Teacher can manage co-teachers.');}
 else if(classroom.teacher_id!==user.id&&!(await tx.query('SELECT 1 FROM classroom_teachers WHERE classroom_id=$1 AND teacher_id=$2 AND active=TRUE',[id,user.id])).rows.length)throw new AppError(404,'Class not found.');
 return classroom;
}
