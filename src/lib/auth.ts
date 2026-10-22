import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { SQL } from './db';
import type { User } from './contracts';
const scrypt = promisify(scryptCallback);
export const cookieName = 'watercycle_session';
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function usernameFor(firstName: string, lastName: string): string {
 return `${firstName}${lastName}`.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
export async function hashPassword(password: string) {
 const salt = randomBytes(16).toString('hex');
 const key = await scrypt(password, salt, 64) as Buffer;
 return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string | null) {
 if (!hash) { await scrypt(password, 'watercycle-dummy-salt', 64); return false; }
 const [algorithm, salt, encoded] = hash.split(':');
 if (algorithm !== 'scrypt' || !salt || !encoded) return false;
 const key = await scrypt(password, salt, 64) as Buffer;
 const expected = Buffer.from(encoded, 'hex');
 return expected.length === key.length && timingSafeEqual(expected, key);
}
export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function safeEqual(a: string, b: string) { const left = Buffer.from(digest(a)); const right = Buffer.from(digest(b)); return timingSafeEqual(left, right); }
export function userFrom(row: Record<string, unknown>): User {
 return { id: String(row.id), role: row.role as User['role'], firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), classroomId: String(row.classroom_id), mustChangePassword: Boolean(row.must_change_password) };
}
export async function createSession(db: SQL, userId: string) {
 const token = randomBytes(32).toString('hex');
 await db.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1,$2,$3)', [digest(token), userId, new Date(Date.now() + 7 * 86400000).toISOString()]);
 return token;
}
export async function sessionUser(db: SQL, token?: string): Promise<User | null> {
 if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
 const { rows } = await db.query('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>CURRENT_TIMESTAMP AND u.enabled=TRUE', [digest(token)]);
 return rows[0] ? userFrom(rows[0]) : null;
}
export async function rateLimit(db: SQL, key: string, max = 12, minutes = 15) {
 const { rows } = await db.query<{ attempts: number }>(`INSERT INTO rate_limits(key,attempts,reset_at) VALUES($1,1,$2)
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN rate_limits.reset_at<CURRENT_TIMESTAMP THEN 1 ELSE rate_limits.attempts+1 END,
 reset_at=CASE WHEN rate_limits.reset_at<CURRENT_TIMESTAMP THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END RETURNING attempts`, [key, new Date(Date.now() + minutes * 60000).toISOString()]);
 if (rows[0].attempts > max) throw new AppError(429, 'Too many attempts. Please wait 15 minutes and try again.');
}
