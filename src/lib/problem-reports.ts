import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SQL } from './db';
import { AppError } from './auth';
import type { ProblemReport, ProblemReportDetail, ProblemReportsState, TicketStatus } from './contracts';

export const reportSchema = z.object({
 teacherName: z.string().trim().min(1,'Please enter your name.').max(100),
 email: z.string().trim().max(254).pipe(z.email('Please enter a valid email address.')),
 description: z.string().trim().min(1,'Please describe the problem.').max(10000),
 requestId: z.string().uuid(),
});
export const reportFiltersSchema = z.object({status:z.enum(['all','need_attention','solved']).optional(),search:z.string().trim().max(254).optional(),cursor:z.string().max(2000).optional(),limit:z.coerce.number().int().min(1).max(100).optional()});
export const reportStatusSchema = z.object({status:z.enum(['need_attention','solved'])});
export type ReportInput = z.infer<typeof reportSchema>;
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
const cursorSchema=z.object({status:z.enum(['need_attention','solved']),time:z.string().datetime({offset:true,precision:6}),id:z.string().uuid()});
function model(row:Record<string,unknown>):ProblemReport {return{id:String(row.id),teacherName:String(row.teacher_name),email:String(row.email),description:String(row.description),submittedAt:new Date(row.submitted_at as string).toISOString(),status:row.status as TicketStatus,resolvedAt:row.resolved_at?new Date(row.resolved_at as string).toISOString():null};}
// These internal helpers receive only an already-authorized SQL connection from WaterCycle.
export async function submitProblemReport(tx:SQL,teacherId:string,raw:ReportInput) {
 const input=reportSchema.parse(raw);
 const {rows:[row]}=await tx.query(`INSERT INTO problem_reports(id,teacher_id,request_id,teacher_name,email,description) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(teacher_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING id,teacher_name,email,description`,[randomUUID(),teacherId,input.requestId,input.teacherName,input.email,input.description]);
 if(row.teacher_name!==input.teacherName||row.email!==input.email||row.description!==input.description)throw new AppError(409,'This submission was already saved with different contents. Start a new report.');
 return{id:String(row.id)};
}
export async function listProblemReports(db:SQL,raw:ReportFilters):Promise<ProblemReportsState> {
 const input=reportFiltersSchema.parse(raw);const values:unknown[]=[];const where:string[]=[];
 const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
 if(input.status&&input.status!=='all')where.push(`p.status=${bind(input.status)}`);
 if(input.search){const term=bind(`%${input.search.replace(/[\\%_]/g,'\\$&')}%`);where.push(`(p.teacher_name ILIKE ${term} ESCAPE '\\' OR p.email ILIKE ${term} ESCAPE '\\' OR p.id ILIKE ${term} ESCAPE '\\')`);}
 if(input.cursor){let cursor:z.infer<typeof cursorSchema>;try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString()));}catch{throw new AppError(400,'This report page is invalid. Refresh the report list.');}
  const status=bind(cursor.status),date=bind(cursor.time),id=bind(cursor.id);where.push(`(p.status>${status} OR (p.status=${status} AND (p.submitted_at,p.id)<(${date}::timestamptz,${id})))`);
 }
 const limit=input.limit??50;
 const {rows}=await db.query(`SELECT p.*,to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM problem_reports p ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY p.status,p.submitted_at DESC,p.id DESC LIMIT ${bind(limit+1)}`,values);
 const {rows:[count]}=await db.query("SELECT COUNT(*) AS n FROM problem_reports WHERE status='need_attention'");
 const page=rows.slice(0,limit),last=page.at(-1);
 return{tickets:page.map(model),attentionCount:Number(count.n),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({status:last.status,time:last.cursor_time,id:last.id})).toString('base64url'):null};
}
export async function problemReportDetail(db:SQL,id:string):Promise<ProblemReportDetail> {
 const {rows:[row]}=await db.query('SELECT * FROM problem_reports WHERE id=$1',[id]);if(!row)throw new AppError(404,'Problem report not found.');
 const {rows}=await db.query('SELECT e.*,u.first_name,u.last_name FROM problem_report_events e JOIN users u ON u.id=e.developer_id WHERE e.report_id=$1 ORDER BY e.changed_at,e.id',[id]);
 return{...model(row),history:rows.map(event=>({id:String(event.id),status:event.status as TicketStatus,changedAt:new Date(event.changed_at as string).toISOString(),developerName:`${event.first_name} ${event.last_name}`}))};
}
export async function updateProblemReport(tx:SQL,developerId:string,id:string,status:TicketStatus) {
 status=reportStatusSchema.parse({status}).status;
 const {rows:[row]}=await tx.query('SELECT status FROM problem_reports WHERE id=$1 FOR UPDATE',[id]);if(!row)throw new AppError(404,'Problem report not found.');
 if(row.status===status)return;
 await tx.query("UPDATE problem_reports SET status=$1,resolved_at=CASE WHEN $1='solved' THEN statement_timestamp() ELSE NULL END,changed_by=$2 WHERE id=$3",[status,developerId,id]);
 await tx.query('INSERT INTO problem_report_events(id,report_id,developer_id,status) VALUES($1,$2,$3,$4)',[randomUUID(),id,developerId,status]);
}
