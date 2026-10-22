import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import { AppError, userFrom } from '../src/lib/auth';
import { WaterCycle, classCreateSchema } from '../src/lib/domain';
import { bootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { migrateDatabase } from '../src/lib/migrations';
import type { Classroom, User } from '../src/lib/contracts';

let db:Database,app:WaterCycle,teacher:User,other:User,admin:User,learner:User,one:Classroom,two:Classroom,foreign:Classroom;
const password='Reporting-test-student-2026!';
const status=(value:number)=>(error:unknown)=>error instanceof AppError&&error.status===value;
async function insertTeacher(username:string) {
  return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES($1,'teacher','Reporting','Teacher',$2) RETURNING *",[randomUUID(),username])).rows[0]);
}
async function trip(id:string,seconds:number,options:{student?:User;classroom?:Classroom;start?:string;ongoing?:boolean;missing?:boolean}={}) {
  const start=options.start??'2026-10-20T12:00:00.000Z';
  await db.query(`INSERT INTO visits(id,student_id,classroom_id,status,requested_at,left_at,returned_at)
    VALUES($1,$2,$3,$4,$5::timestamptz-INTERVAL '1 minute',$6::timestamptz,
      CASE WHEN $4='out' THEN NULL ELSE $5::timestamptz+$7::double precision*INTERVAL '1 second' END)`,
    [id,(options.student??learner).id,(options.classroom??one).id,options.ongoing?'out':'returned',start,options.missing?null:start,seconds]);
}
describe('Timestamp-derived rule offenders and private classroom reporting',()=>{
  before(async()=>{db=await createDatabase({directory:'memory://',bootstrapAdmin:false});app=new WaterCycle(db);});
  beforeEach(async()=>{
    await db.query('TRUNCATE rate_limits,sessions,quizzes,visits,questions,enrollments,users,classrooms CASCADE');
    await bootstrapAdministrator(db,randomBytes(32).toString('base64url'));
    admin=userFrom((await db.query("SELECT * FROM users WHERE role='admin'")).rows[0]);
    teacher=await insertTeacher('reportteacher');other=await insertTeacher('foreignteacher');
    one=await app.createClass(teacher,{name:'Biology A',period:'1',code:'REP01'});
    two=await app.createClass(teacher,{name:'Biology B',period:'2',code:'REP02',timeZone:'Asia/Taipei'});
    foreign=await app.createClass(other,{name:'Other biology',code:'REP03'});
    learner=await app.signup({firstName:'Jamie',lastName:'Report',password,classroomCode:'rep01'});
  });
  after(async()=>await db.close());

  it('excludes 10 minutes, late breaks up to exactly 12 minutes, and missing/unreliable timestamps',async()=>{
    for(const seconds of [600,601,719,720])await trip(`not-${seconds}`,seconds);
    await trip('missing-start',1000,{missing:true});
    await trip('negative-duration',-1);
    await trip('above-by-a-millisecond',720.001);
    const state=await app.ruleOffenders(teacher);
    assert.deepEqual(state.violations.map(row=>row.id),['above-by-a-millisecond']);
    assert.equal(state.violations[0].totalViolations,1);
    assert.equal(state.violations[0].durationSeconds,720.001);
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM visits')).rows[0].n,7);
  });

  it('lists newest violations first and reports original classroom timezone and total per student',async()=>{
    await trip('older',780,{start:'2026-10-20T12:00:00Z'});
    await trip('newer',900,{start:'2026-10-21T12:00:00Z'});
    const state=await app.ruleOffenders(teacher);
    assert.deepEqual(state.violations.map(row=>row.id),['newer','older']);
    assert.ok(state.violations.every(row=>row.totalViolations===2));
    assert.equal(state.violations[0].violatedAt,'2026-10-21T12:12:00.000Z');
    assert.equal(state.violations[0].timeZone,'America/New_York');
    assert.equal(state.violations[0].ongoing,false);
  });

  it('keeps one ongoing violation through polling, warning acknowledgement, and return without suspending privileges',async()=>{
    const start=new Date(Date.now()-780000).toISOString();
    await trip('ongoing',780,{start,ongoing:true});
    const before=(await db.query('SELECT * FROM visits')).rows;
    for(let i=0;i<3;i++) {
      const result=await app.ruleOffenders(teacher);
      assert.equal(result.violations.length,1);assert.equal(result.violations[0].id,'ongoing');
      assert.equal(result.violations[0].ongoing,true);assert.equal(result.violations[0].totalViolations,1);
      assert.ok(result.violations[0].durationSeconds>=780);
    }
    assert.deepEqual((await db.query('SELECT * FROM visits')).rows,before,'reporting is read-only');
    await app.acknowledgeWarning(learner,'ongoing');await app.acknowledgeWarning(learner,'ongoing');
    assert.equal((await app.ruleOffenders(teacher)).violations[0].totalViolations,1);
    await app.studentAction(learner,'return');
    const returned=(await app.ruleOffenders(teacher)).violations[0];
    assert.equal(returned.id,'ongoing');assert.equal(returned.ongoing,false);assert.ok(returned.returnedAt);
    assert.equal(returned.totalViolations,1);
    assert.equal((await app.studentState(learner)).canRequestPass,true);
    assert.equal((await db.query('SELECT enabled FROM users WHERE id=$1',[learner.id])).rows[0].enabled,true);
  });

  it('allows warning acknowledgement at 12 minutes but not before, preserving its first timestamp',async()=>{
    await trip('warning',719,{start:new Date(Date.now()-719000).toISOString(),ongoing:true});
    await assert.rejects(()=>app.acknowledgeWarning(learner,'warning'),status(409));
    await db.query("UPDATE visits SET left_at=statement_timestamp()-INTERVAL '12 minutes' WHERE id='warning'");
    await app.acknowledgeWarning(learner,'warning');
    const first=(await app.studentState(learner)).currentVisit!;
    assert.ok(first.warningAcknowledgedAt);assert.equal(first.status,'out');
    await app.acknowledgeWarning(learner,'warning');
    assert.equal((await app.studentState(learner)).currentVisit?.warningAcknowledgedAt,first.warningAcknowledgedAt);
  });

  it('filters by class and literal student-name search while preserving historical attribution and scoped totals after transfer',async()=>{
    await trip('original-1',800);await trip('original-2',900);
    await app.transferStudent(teacher,learner.id,two.id);
    await trip('transferred',850,{classroom:two});
    const filtered=await app.ruleOffenders(teacher,{classroomId:two.id,search:'JAMIE reP'});
    assert.deepEqual(filtered.violations.map(row=>row.id),['transferred']);
    assert.equal(filtered.violations[0].totalViolations,3);
    assert.equal(filtered.violations[0].timeZone,'Asia/Taipei');
    assert.equal((await app.ruleOffenders(teacher,{classroomId:one.id})).violations.length,2);
    assert.equal((await app.ruleOffenders(teacher,{search:'%'})).violations.length,0);
    assert.equal((await app.ruleOffenders(teacher,{search:'Unknown'})).violations.length,0);
    await app.updateClass(teacher,one.id,{archived:true});
    assert.equal((await app.ruleOffenders(teacher,{classroomId:one.id})).violations.length,2);
  });

  it('enforces teacher ownership and student exclusion while retaining privileged oversight across teacher changes',async()=>{
    await trip('original-owner',800);
    await app.removeStudent(teacher,learner.id);await app.enrollStudent(learner,foreign.code!);
    await trip('new-owner',900,{classroom:foreign});
    assert.deepEqual((await app.ruleOffenders(teacher)).violations.map(row=>row.id),['original-owner']);
    assert.deepEqual((await app.ruleOffenders(other)).violations.map(row=>row.id),['new-owner']);
    await assert.rejects(()=>app.ruleOffenders(teacher,{classroomId:foreign.id}),status(404));
    await assert.rejects(()=>app.ruleOffenders(learner),status(403));
    const all=await app.ruleOffenders(admin);
    assert.equal(all.violations.length,2);assert.ok(all.violations.every(row=>row.totalViolations===2));
    assert.equal((await app.ruleOffenders(teacher)).violations[0].totalViolations,1);
  });

  it('paginates stable break identifiers without duplicates or loss across microsecond timestamp boundaries',async()=>{
    await trip('z-one',800,{start:'2026-10-20T12:00:00.000001Z'});
    await trip('a-two',800,{start:'2026-10-20T12:00:00.000002Z'});
    await trip('m-three',800,{start:'2026-10-20T12:00:00.000003Z'});
    const ids:string[]=[];let cursor:string|undefined;
    do {
      const page=await app.ruleOffenders(teacher,{limit:1,cursor});
      ids.push(...page.violations.map(row=>row.id));cursor=page.nextCursor??undefined;
      assert.ok(page.violations.every(row=>row.totalViolations===3));
    }while(cursor&&ids.length<5);
    assert.deepEqual(ids,['m-three','a-two','z-one']);assert.equal(new Set(ids).size,3);
    await assert.rejects(()=>app.ruleOffenders(teacher,{cursor:'invalid-cursor'}),status(400));
  });

  it('validates class timezones and upgrades a version-two database without rewriting records',async()=>{
    assert.equal(classCreateSchema.safeParse({name:'Invalid',code:'REP04',timeZone:'Mars/School'}).success,false);
    await trip('preserved-history',800);
    const beforeUsers=(await db.query('SELECT * FROM users ORDER BY id')).rows;
    const beforeVisits=(await db.query('SELECT * FROM visits ORDER BY id')).rows;
    await db.query('ALTER TABLE classrooms DROP COLUMN time_zone');
    await db.query('DROP INDEX visits_departure_reporting');
    await db.query('DELETE FROM watercycle_migrations WHERE version=3');
    await db.transaction(async tx=>await migrateDatabase(tx,async sql=>{for(const statement of sql.split(';').filter(part=>part.trim()))await tx.query(statement);}));
    assert.deepEqual((await db.query('SELECT * FROM users ORDER BY id')).rows,beforeUsers);
    assert.deepEqual((await db.query('SELECT * FROM visits ORDER BY id')).rows,beforeVisits);
    assert.ok((await db.query('SELECT time_zone FROM classrooms')).rows.every(row=>row.time_zone==='America/New_York'));
    await app.updateClass(teacher,one.id,{timeZone:'Europe/London'});
    assert.equal((await app.ruleOffenders(teacher)).violations[0].timeZone,'Europe/London');
    assert.deepEqual((await db.query('SELECT * FROM visits ORDER BY id')).rows,beforeVisits);
  });
});
