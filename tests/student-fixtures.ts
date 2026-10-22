import type { Database } from '../src/lib/db';
import type { WaterCycle } from '../src/lib/domain';
import type { User } from '../src/lib/contracts';
import { userFrom } from '../src/lib/auth';
// Existing workflow regression fixtures explicitly obtain teacher approval.
// Approval restrictions themselves are tested without this helper.
export async function approveStudent(db:Database,app:WaterCycle,student:User):Promise<User> {
 const {rows:[owner]}=await db.query('SELECT t.* FROM users t JOIN classrooms c ON c.teacher_id=t.id JOIN users s ON s.classroom_id=c.id WHERE s.id=$1',[student.id]);
 await app.updateRoster(userFrom(owner),student.id,{accountStatus:'active'});
 return userFrom((await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0]);
}
