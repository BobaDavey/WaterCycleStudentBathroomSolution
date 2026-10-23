import type { SQL } from './db';

// Keep this baseline compatible with the original deployment. Versioned changes
// run in the same transaction, after its original tables are present.
export const baselineSchema = `
CREATE TABLE IF NOT EXISTS classrooms (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, capacity INTEGER NOT NULL DEFAULT 2 CHECK(capacity = 2)
);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('teacher','student')), first_name TEXT NOT NULL, last_name TEXT NOT NULL,
 username TEXT NOT NULL UNIQUE, password_hash TEXT, classroom_id TEXT NOT NULL REFERENCES classrooms(id), enabled BOOLEAN NOT NULL DEFAULT TRUE,
 must_change_password BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS questions (
 id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id), prompt TEXT NOT NULL, options JSONB NOT NULL,
 correct_index INTEGER NOT NULL, topic TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
 deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS quizzes (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), questions JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 used BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS visits (
 id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id), student_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('waiting','ready','out','returned','cancelled')),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, ready_at TIMESTAMPTZ, left_at TIMESTAMPTZ, returned_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_visit ON visits(student_id) WHERE status IN ('waiting','ready','out');
CREATE INDEX IF NOT EXISTS visits_classroom ON visits(classroom_id, requested_at);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS watercycle_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
`;

export const multiTeacherMigration = `
ALTER TABLE users ALTER COLUMN classroom_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','teacher','student'));
ALTER TABLE classrooms ADD COLUMN teacher_id TEXT REFERENCES users(id);
ALTER TABLE classrooms ADD COLUMN period TEXT;
ALTER TABLE classrooms ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classrooms ADD COLUMN legacy_code TEXT;
ALTER TABLE classrooms ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
DO $$ BEGIN
 IF EXISTS (
  SELECT c.id FROM classrooms c LEFT JOIN users u ON u.classroom_id=c.id AND u.role='teacher'
  GROUP BY c.id HAVING COUNT(u.id) <> 1
 ) THEN RAISE EXCEPTION 'Class ownership is missing or ambiguous. No records were changed; resolve ownership before migration.';
 END IF;
END $$;
UPDATE classrooms c SET teacher_id=u.id FROM users u WHERE u.classroom_id=c.id AND u.role='teacher';
ALTER TABLE classrooms ALTER COLUMN teacher_id SET NOT NULL;
ALTER TABLE classrooms DROP CONSTRAINT classrooms_code_key;
ALTER TABLE classrooms ALTER COLUMN code DROP NOT NULL;
UPDATE classrooms SET legacy_code=code,code=NULL WHERE code !~ '^[0-9]{5}$';
ALTER TABLE classrooms ADD CONSTRAINT classrooms_code_format CHECK(code IS NULL OR code ~ '^[0-9]{5}$');
ALTER TABLE classrooms ADD CONSTRAINT classrooms_code_required CHECK(code IS NOT NULL OR legacy_code IS NOT NULL);
CREATE UNIQUE INDEX classrooms_active_code_unique ON classrooms(code) WHERE archived=FALSE AND code IS NOT NULL;
CREATE INDEX classrooms_teacher ON classrooms(teacher_id,archived);
CREATE TABLE enrollments (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), classroom_id TEXT NOT NULL REFERENCES classrooms(id),
 active BOOLEAN NOT NULL DEFAULT TRUE, joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, left_at TIMESTAMPTZ,
 UNIQUE(student_id,classroom_id)
);
CREATE UNIQUE INDEX enrollments_one_active_student ON enrollments(student_id) WHERE active=TRUE;
CREATE INDEX enrollments_classroom ON enrollments(classroom_id,active);
INSERT INTO enrollments(id,student_id,classroom_id,active,joined_at)
 SELECT 'legacy-'||id,id,classroom_id,TRUE,created_at FROM users WHERE role='student' AND classroom_id IS NOT NULL;
ALTER TABLE quizzes ADD COLUMN classroom_id TEXT REFERENCES classrooms(id);
UPDATE quizzes q SET classroom_id=u.classroom_id FROM users u WHERE q.student_id=u.id;
CREATE UNIQUE INDEX watercycle_one_administrator ON users(role) WHERE role='admin';
ALTER TABLE users ADD CONSTRAINT administrator_identity CHECK(role <> 'admin' OR (username='davidanzezhang' AND enabled=TRUE AND classroom_id IS NULL));
CREATE FUNCTION protect_watercycle_administrator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.role='admin' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'The administrator account cannot be deleted.' USING ERRCODE='23514';
  END IF;
  IF NEW.role <> 'admin' OR NEW.username <> 'davidanzezhang' OR NEW.enabled <> TRUE THEN
   RAISE EXCEPTION 'The administrator account cannot be demoted, renamed, or disabled.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_watercycle_administrator BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION protect_watercycle_administrator();
`;

const studentBreakMigration = `
ALTER TABLE classrooms DROP CONSTRAINT classrooms_code_format;
ALTER TABLE classrooms ADD CONSTRAINT classrooms_code_format CHECK(code IS NULL OR code COLLATE "C" ~ '^[A-Z0-9]{5}$');
CREATE FUNCTION normalize_watercycle_class_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.code IS NOT NULL THEN
  IF NEW.code COLLATE "C" !~ '^[A-Za-z0-9]{5}$' THEN
   RAISE EXCEPTION 'Class codes must contain exactly five English letters or numbers.' USING ERRCODE='23514';
  END IF;
  NEW.code=UPPER(NEW.code COLLATE "C");
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER normalize_watercycle_class_code BEFORE INSERT OR UPDATE OF code ON classrooms FOR EACH ROW EXECUTE FUNCTION normalize_watercycle_class_code();
ALTER TABLE users ADD COLUMN tutorial_completed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE visits ADD COLUMN purpose TEXT CHECK(purpose IN ('restroom','water'));
ALTER TABLE visits ADD COLUMN ready_expires_at TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN warning_acknowledged_at TIMESTAMPTZ;
UPDATE visits SET ready_expires_at=CURRENT_TIMESTAMP+INTERVAL '120 seconds' WHERE status='ready';
ALTER TABLE quizzes ADD COLUMN purpose TEXT CHECK(purpose IN ('restroom','water'));
ALTER TABLE quizzes ADD COLUMN correct_count INTEGER NOT NULL DEFAULT 0 CHECK(correct_count BETWEEN 0 AND 2);
ALTER TABLE quizzes ADD COLUMN current_index INTEGER NOT NULL DEFAULT 0 CHECK(current_index>=0);
ALTER TABLE quizzes ADD COLUMN question_token TEXT;
ALTER TABLE quizzes ADD COLUMN seen_question_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quizzes ADD COLUMN answer_history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quizzes ADD COLUMN visit_id TEXT REFERENCES visits(id);
UPDATE quizzes SET used=TRUE WHERE used=FALSE;
`;

export const approvalAndSupportMigration = `
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'pending' CHECK(account_status IN ('pending','active','deactivated'));
UPDATE users SET account_status=CASE WHEN enabled THEN 'active' ELSE 'deactivated' END WHERE role='student';
ALTER TABLE users ADD COLUMN registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE users SET registered_at=created_at;
ALTER TABLE users ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN approved_by TEXT REFERENCES users(id);
CREATE TABLE student_status_events (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), teacher_id TEXT NOT NULL REFERENCES users(id),
 classroom_id TEXT NOT NULL REFERENCES classrooms(id), previous_status TEXT NOT NULL, status TEXT NOT NULL,
 changed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX students_pending_approval ON users(account_status,registered_at,id) WHERE role='student';
ALTER TABLE visits ADD COLUMN capacity_paused BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE break_corrections (
 id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(id), teacher_id TEXT NOT NULL REFERENCES users(id),
 incorrect_returned_at TIMESTAMPTZ NOT NULL, corrected_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(), reason TEXT NOT NULL
);
CREATE INDEX break_corrections_visit ON break_corrections(visit_id,corrected_at);
CREATE TABLE problem_reports (
 id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 teacher_name TEXT NOT NULL, email TEXT NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'need_attention' CHECK(status IN ('need_attention','solved')),
 submitted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(), resolved_at TIMESTAMPTZ, changed_by TEXT REFERENCES users(id),
 UNIQUE(teacher_id,request_id)
);
CREATE INDEX problem_reports_order ON problem_reports(status,submitted_at DESC,id DESC);
CREATE TABLE problem_report_events (
 id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES problem_reports(id), developer_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('need_attention','solved')), changed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX problem_report_events_report ON problem_report_events(report_id,changed_at,id);
`;

export const enrollmentScheduleMigration = `
-- Retain legacy account fields and historical membership rows. New permissions
-- belong to each enrollment; account_suspended is a separate security control.
ALTER TABLE users ADD COLUMN account_suspended BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET account_suspended=TRUE WHERE role='student' AND enabled=FALSE;
ALTER TABLE enrollments ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','deactivated'));
ALTER TABLE enrollments ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE enrollments ADD COLUMN approved_by TEXT REFERENCES users(id);
UPDATE enrollments e SET status=CASE WHEN NOT e.active OR NOT u.enabled OR u.account_status='deactivated' THEN 'deactivated' WHEN u.account_status='active' THEN 'approved' ELSE 'pending' END,
 approved_at=CASE WHEN e.active AND u.classroom_id=e.classroom_id THEN u.approved_at END,
 approved_by=CASE WHEN e.active AND u.classroom_id=e.classroom_id THEN u.approved_by END FROM users u WHERE u.id=e.student_id;
DROP INDEX enrollments_one_active_student;
CREATE INDEX enrollments_pending ON enrollments(classroom_id,joined_at,id) WHERE active=TRUE AND status='pending';
ALTER TABLE classrooms ADD COLUMN start_time TEXT;
ALTER TABLE classrooms ADD COLUMN end_time TEXT;
ALTER TABLE classrooms ADD COLUMN schedule_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5];
ALTER TABLE classrooms ADD CONSTRAINT class_schedule_times CHECK(
 (start_time IS NULL AND end_time IS NULL) OR
 (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND start_time<end_time));
ALTER TABLE classrooms ADD CONSTRAINT class_schedule_days CHECK(cardinality(schedule_days)>0 AND schedule_days <@ ARRAY[1,2,3,4,5,6,7]);
ALTER TABLE visits ADD COLUMN cancellation_reason TEXT;
CREATE TABLE student_username_counters (base TEXT PRIMARY KEY,next_number BIGINT NOT NULL CHECK(next_number>0));
-- Seed the high-water mark from all roles, without changing any username.
INSERT INTO student_username_counters(base,next_number)
 SELECT parts[1],MAX(parts[2]::bigint)+1 FROM (SELECT regexp_match(username,'^(.+?)([0-9]{2,9})$') AS parts FROM users) names
 WHERE parts IS NOT NULL GROUP BY parts[1];
`;

export const migrations = [
 {version:1,sql:multiTeacherMigration},
 {version:2,sql:studentBreakMigration},
 {version:3,sql:`ALTER TABLE classrooms ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'America/New_York';
CREATE INDEX visits_departure_reporting ON visits(classroom_id,left_at DESC,id DESC) WHERE left_at IS NOT NULL;`},
 {version:4,sql:approvalAndSupportMigration},
 {version:5,sql:`CREATE TABLE watercycle_database_identity (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),
 environment TEXT NOT NULL CHECK(environment IN ('production','preview','development')),
 database_id UUID NOT NULL UNIQUE, bound_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE watercycle_migration_runs (
 id UUID PRIMARY KEY, environment TEXT NOT NULL, database_id UUID NOT NULL, backup_reference TEXT NOT NULL,
 versions_before INTEGER[] NOT NULL, versions_after INTEGER[] NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);`},
 {version:6,sql:enrollmentScheduleMigration},
] as const;
export const latestMigrationVersion = migrations.at(-1)!.version;
/** Caller holds the PostgreSQL initialization lock and transaction. */
export async function migrateDatabase(tx: SQL, execute: (sql:string) => Promise<void>): Promise<void> {
 await execute(baselineSchema);
 const {rows}=await tx.query<{version:number}>('SELECT version FROM watercycle_migrations');
 const versions=rows.map(row=>Number(row.version)).sort((a,b)=>a-b);
 if(versions.some((version,index)=>version!==index+1)||versions.some(version=>version>latestMigrationVersion))throw new Error('The database migration history is incompatible with this release. No migrations were applied.');
 for(const migration of migrations)if(!versions.includes(migration.version)){
  await execute(migration.sql);
  await tx.query('INSERT INTO watercycle_migrations(version) VALUES($1)',[migration.version]);
 }
}
