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

/** Caller holds the PostgreSQL initialization lock and transaction. */
export async function migrateDatabase(tx: SQL, execute: (sql:string) => Promise<void>): Promise<void> {
 await execute(baselineSchema);
 const { rows } = await tx.query<{ version: number }>('SELECT version FROM watercycle_migrations');
 if (!rows.some(row => Number(row.version) === 1)) {
  await execute(multiTeacherMigration);
  await tx.query('INSERT INTO watercycle_migrations(version) VALUES(1)');
 }
 if (!rows.some(row => Number(row.version) === 2)) {
  await execute(studentBreakMigration);
  await tx.query('INSERT INTO watercycle_migrations(version) VALUES(2)');
 }
}
