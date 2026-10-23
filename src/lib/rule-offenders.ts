import { effectiveTimeZone } from './time-zones';
import { z } from 'zod';
import type { SQL } from './db';
import { AppError } from './auth';
import type { RuleOffendersState, RuleViolation } from './contracts';

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string().min(1).max(200) });
export const ruleOffendersSchema = z.object({
  classroomId: z.string().min(1).max(200).optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RuleOffendersFilters = z.input<typeof ruleOffendersSchema>;

/** Caller verifies the role and passes an immutable teacher scope, or null for admin oversight. */
export async function loadRuleOffenders(db: SQL, teacherId: string | null, filters: RuleOffendersFilters): Promise<RuleOffendersState> {
  const input = ruleOffendersSchema.parse(filters);
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
    catch { throw new AppError(400, 'This activity page is unavailable. Refresh the list and try again.'); }
  }
  const search = input.search ? `%${input.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  // The break id is the violation id. Reading or acknowledging a warning never
  // writes another event. Totals precede filters/pagination and retain the
  // break's original classroom ownership after a student transfers.
  const { rows } = await db.query<Record<string, unknown>>(`
    WITH timed AS (
      SELECT v.id,v.student_id,v.classroom_id,v.left_at,v.returned_at,
        c.name AS classroom_name,c.period,c.time_zone,
        u.first_name||' '||u.last_name AS student_name,
        v.left_at+INTERVAL '12 minutes' AS violated_at,
        CASE WHEN v.status='out' AND v.returned_at IS NULL THEN statement_timestamp()
             WHEN v.status='returned' THEN v.returned_at END AS ended_at,
        v.status='out' AS ongoing
      FROM visits v JOIN classrooms c ON c.id=v.classroom_id JOIN users u ON u.id=v.student_id
      WHERE ($1::text IS NULL OR c.teacher_id=$1) AND v.left_at IS NOT NULL
    ), violations AS (
      SELECT *,COUNT(*) OVER(PARTITION BY student_id) AS total_violations,
        EXTRACT(EPOCH FROM(ended_at-left_at)) AS duration_seconds
      FROM timed WHERE ended_at>violated_at
    )
    SELECT *,statement_timestamp() AS server_now,
      to_char(violated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM violations
    WHERE ($2::text IS NULL OR classroom_id=$2)
      AND ($3::text IS NULL OR student_name ILIKE $3)
      AND ($4::timestamptz IS NULL OR (violated_at,id)<($4::timestamptz,$5::text))
    ORDER BY violated_at DESC,id DESC LIMIT $6`,
    [teacherId,input.classroomId ?? null,search,cursor?.at ?? null,cursor?.id ?? null,input.limit+1]);
  const iso = (value: unknown) => new Date(value as string | Date).toISOString();
  const visible = rows.slice(0,input.limit);
  const violations: RuleViolation[] = visible.map(row => ({
    id:String(row.id), studentId:String(row.student_id), studentName:String(row.student_name),
    classroomId:String(row.classroom_id),classroomName:String(row.classroom_name),period:row.period == null ? null : String(row.period),
    timeZone:effectiveTimeZone(row.time_zone as string | null),violatedAt:iso(row.violated_at),leftAt:iso(row.left_at),
    returnedAt:row.returned_at ? iso(row.returned_at) : null,durationSeconds:Number(row.duration_seconds),
    ongoing:Boolean(row.ongoing),totalViolations:Number(row.total_violations),
  }));
  const last=violations.at(-1);
  const nextCursor=rows.length>input.limit && last ? Buffer.from(JSON.stringify({at:String(visible.at(-1)!.cursor_at),id:last.id})).toString('base64url') : null;
  const serverNow=rows[0]?.server_now ?? (await db.query<{now:Date}>('SELECT statement_timestamp() AS now')).rows[0].now;
  return { violations,nextCursor,serverNow:iso(serverNow) };
}
