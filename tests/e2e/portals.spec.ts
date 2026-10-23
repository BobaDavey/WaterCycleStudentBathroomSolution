import { test, expect, type Page } from '@playwright/test';
import type { AdminState, StudentState, TeacherState } from '../../src/lib/contracts';
import { qualifyBreak } from './break-helpers';

const origin = 'http://127.0.0.1:3100';
const headers = { Origin: origin, 'Content-Type': 'application/json' };
async function login(page: Page, username: string, password: string, teacher = false) {
  await page.goto('/');
  await page.getByRole('button', { name: teacher ? 'I’m a teacher' : 'I’m a student' }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
async function adminLogin(page: Page) {
  await page.goto('/admin/login');
  await expect(page.getByLabel('Developer username', { exact: true })).toHaveValue('');
  await page.getByLabel('Developer username', { exact: true }).fill('watercycledev');
  await page.getByLabel('Password', { exact: true }).fill(process.env.WATERCYCLE_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Developer Sign In' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole('navigation', { name: 'Administrator navigation' })).toBeVisible();
}
async function signup(page: Page, firstName: string, lastName: string, code: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Create a student account/ }).click();
  await page.getByLabel('First name', { exact: true }).fill(firstName);
  await page.getByLabel('Last name', { exact: true }).fill(lastName);
  await page.getByLabel('Classroom code', { exact: true }).fill(code);
  await expect(page.getByLabel('Classroom code', { exact: true })).toHaveValue(code.toUpperCase());
  await page.getByLabel('Password', { exact: true }).fill('PrivateStudent2026!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Hey, ${firstName}`) })).toBeVisible();
  await page.getByRole('button', { name: "Got It! Let's Go", exact: true }).click();
}

test('teacher class overview, leading-zero enrollment, duplicate errors, transfer, removal, and archived return', async ({ browser }) => {
  test.setTimeout(120000);
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  try {
    const teacher = await teacherContext.newPage();
    const student = await studentContext.newPage();
    await login(teacher, 'morganreed', 'WaterCycle2026!', true);
    await teacher.getByRole('button', { name: 'Class Roster', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Student roster', exact: true })).toHaveCount(0);
    await expect(teacher.getByRole('article').filter({ hasText: '01001' })).toBeVisible();
    await expect(teacher.getByRole('article').filter({ hasText: '02001' })).toHaveCount(0);
    await teacher.getByRole('button', { name: 'Create Class', exact: true }).click();
    let dialog = teacher.getByRole('dialog');
    await dialog.getByLabel('Class name', { exact: true }).fill('Biology browser class');
    await dialog.getByLabel('Class period', { exact: true }).fill('9');
    await dialog.getByLabel('Enrollment code', { exact: true }).fill('bio09');
    await expect(dialog.getByLabel('Enrollment code', { exact: true })).toHaveValue('BIO09');
    await dialog.getByRole('button', { name: 'Create Class', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    let card = teacher.getByRole('article').filter({ has: teacher.getByRole('heading', { name: 'Biology browser class', exact: true }) });
    await expect(card.getByText('BIO09', { exact: true })).toBeVisible();
    await teacher.getByRole('button', { name: 'Create Class', exact: true }).click();
    dialog = teacher.getByRole('dialog');
    await dialog.getByLabel('Class name', { exact: true }).fill('Duplicate code test');
    await dialog.getByLabel('Enrollment code', { exact: true }).fill('bIo09');
    await dialog.getByRole('button', { name: 'Create Class', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/code|use|unique/i);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await card.getByRole('button', { name: 'Edit Class', exact: true }).click();
    dialog = teacher.getByRole('dialog');
    await dialog.getByLabel('Class name', { exact: true }).fill('Biology browser class updated');
    await dialog.getByLabel('Enrollment code', { exact: true }).fill('bio10');
    await dialog.getByRole('button', { name: 'Save Class', exact: true }).click();
    card = teacher.getByRole('article').filter({ has: teacher.getByRole('heading', { name: 'Biology browser class updated', exact: true }) });
    await expect(card.getByText('BIO10', { exact: true })).toBeVisible();
    const surname = `Enrollment${Date.now()}`;
    await signup(student, 'Robin', surname, 'bio10');
    const username = `robin${surname}`.toLowerCase();
    let studentState = await (await student.request.get('/api/student/state')).json() as StudentState;
    expect(studentState.classroom?.code).toBe('BIO10');
    await card.getByRole('button', { name: 'View Class', exact: true }).click();
    const row = teacher.getByRole('row').filter({ hasText: username });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Transfer', exact: true }).click();
    dialog = teacher.getByRole('dialog');
    const state = await (await teacher.request.get('/api/teacher/state')).json() as TeacherState;
    const destination = state.classes.find(c => c.code === '01001')!;
    await dialog.getByLabel('Destination class').selectOption(destination.id);
    await dialog.getByRole('button', { name: 'Confirm transfer', exact: true }).click();
    await expect(row).not.toBeVisible();
    await teacher.getByLabel('Selected class', { exact: true }).selectOption(destination.id);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await teacher.getByRole('dialog').getByRole('button', { name: 'Remove from class', exact: true }).click();
    await expect(row).not.toBeVisible();
    await expect(student.getByRole('button', { name: /Join class/i })).toBeVisible();
    await student.getByLabel('Class enrollment code', { exact: true }).fill('bio10');
    await student.getByRole('button', { name: /Join class/i }).click();
    await expect(student.getByRole('button', { name: 'Request a Break', exact: true })).toBeVisible();
    studentState = await (await student.request.get('/api/student/state')).json() as StudentState;
    const target = studentState.classroom!;
    expect(studentState.user.accountStatus).toBe('pending');
    expect((await teacher.request.patch(`/api/teacher/roster/${studentState.user.id}`, { headers, data: { accountStatus: 'active' } })).ok()).toBe(true);
    await expect(student.getByText('Your account is awaiting teacher approval.', { exact: true })).toHaveCount(0);
    const questions = (await (await teacher.request.get(`/api/teacher/state?classroomId=${target.id}`)).json() as TeacherState).questions;
    await qualifyBreak(student, questions, 'water');
    await teacher.getByRole('button', { name: 'Back to Class Roster' }).click();
    await card.getByRole('button', { name: 'Archive Class', exact: true }).click();
    await teacher.getByRole('dialog').getByRole('button', { name: 'Archive Class', exact: true }).click();
    await teacher.getByRole('tab', { name: /Archived classes/i }).click();
    await expect(card).toBeVisible();
    await expect(student.getByRole('button', { name: "I'm Back", exact: true })).toBeVisible();
    await student.getByRole('button', { name: "I'm Back", exact: true }).click();
    await expect(student.getByRole('button', { name: 'Request a Break', exact: true })).toBeDisabled();
    const returned = await (await student.request.get('/api/student/state')).json() as StudentState;
    expect(returned.recentVisits[0].classroomId).toBe(target.id);
    expect(returned.recentVisits[0].returnedAt).toBeTruthy();
    expect(returned.recentVisits[0].purpose).toBe('water');
    const rejected = await teacher.request.post('/api/auth/signup', { headers, data: { firstName: 'Not', lastName: `Enrolled${Date.now()}`, password: 'Student2026!', classroomCode: 'bio10' } });
    expect(rejected.status()).toBe(400);
  } finally { await teacherContext.close(); await studentContext.close(); }
});

test('sole admin creates and deactivates a teacher; temporary password gate and read-only class oversight', async ({ browser }) => {
  test.setTimeout(120000);
  const adminContext = await browser.newContext();
  const teacherContext = await browser.newContext();
  const blockedContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    const teacher = await teacherContext.newPage();
    const blocked = await blockedContext.newPage();
    await blocked.goto('/admin/dashboard');
    await expect(blocked).toHaveURL(/\/admin\/login/);
    await adminLogin(admin);
    await admin.getByRole('button', { name: 'Teachers', exact: true }).click();
    await admin.getByRole('button', { name: 'Create Teacher', exact: true }).click();
    let dialog = admin.getByRole('dialog');
    const username = `browserteacher${Date.now()}`;
    await dialog.getByLabel('First name', { exact: true }).fill('Casey');
    await dialog.getByLabel('Last name', { exact: true }).fill('Browser');
    await dialog.getByLabel('Username or email', { exact: true }).fill(username);
    await dialog.getByLabel('Email', { exact: true }).fill('casey@example.org');
    await dialog.getByLabel('Temporary password', { exact: true }).fill('TemporaryTeacher2026!');
    await dialog.getByRole('button', { name: 'Create Teacher', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const teacherRow = admin.getByRole('row').filter({ hasText: username });
    await expect(teacherRow).toBeVisible();
    await login(teacher, username, 'TemporaryTeacher2026!', true);
    await expect(teacher.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible();
    await expect(teacher.getByRole('button', { name: 'Class Roster', exact: true })).toBeDisabled();
    await teacher.getByLabel('Temporary password', { exact: true }).fill('TemporaryTeacher2026!');
    await teacher.getByLabel('New password', { exact: true }).fill('MyOwnTeacher2026!');
    await teacher.getByLabel('Confirm new password', { exact: true }).fill('MyOwnTeacher2026!');
    await teacher.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Class Roster', exact: true })).toBeEnabled();
    await teacher.getByRole('button', { name: 'Class Roster', exact: true }).click();
    await teacher.getByRole('button', { name: 'Create Class', exact: true }).first().click();
    dialog = teacher.getByRole('dialog');
    await dialog.getByLabel('Class name', { exact: true }).fill('Teacher-created biology');
    await dialog.getByLabel('Class period', { exact: true }).fill('10');
    await dialog.getByLabel('Enrollment code', { exact: true }).fill('00010');
    await dialog.getByRole('button', { name: 'Create Class', exact: true }).click();
    await expect(teacher.getByRole('article').filter({ hasText: '00010' })).toBeVisible();
    await teacherRow.getByRole('button', { name: 'View teacher', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Teacher-created biology', exact: true })).toBeVisible();
    await admin.getByRole('article').filter({ hasText: '00010' }).getByRole('button', { name: 'View class', exact: true }).click();
    await expect(admin.getByRole('dialog')).toContainText('Teacher-created biology');
    await expect(admin.getByRole('dialog').getByRole('button', { name: /Remove|Transfer|Reset password/ })).toHaveCount(0);
    await admin.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await admin.getByRole('button', { name: 'Deactivate teacher', exact: true }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Deactivate teacher', exact: true }).click();
    await expect(teacher.getByRole('heading', { name: 'Good to see you.', exact: true })).toBeVisible();
    const state = await (await admin.request.get('/api/admin/state')).json() as AdminState;
    expect(state.teachers.find(t => t.username === username)?.enabled).toBe(false);
    expect(state.classes.some(c => c.code === '00010')).toBe(true);
    const denied = await blocked.request.post('/api/auth/login', { headers, data: { username, password: 'MyOwnTeacher2026!', role: 'teacher' } });
    expect(denied.status()).toBe(401);
  } finally { await adminContext.close(); await teacherContext.close(); await blockedContext.close(); }
});

test('teacher and student sessions cannot access admin APIs or another teacher class', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, 'morganreed', 'WaterCycle2026!', true);
    expect((await page.request.get('/api/admin/state')).status()).toBe(403);
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/admin\/login/);
    const second = await browser.newContext();
    try {
      const maria = await second.newPage();
      await login(maria, 'mariamiller', 'WaterCycle2026!', true);
      const state = await (await maria.request.get('/api/teacher/state')).json() as TeacherState;
      expect((await page.request.get(`/api/teacher/state?classroomId=${state.classroom!.id}`)).status()).toBe(404);
    } finally { await second.close(); }
    await page.request.post('/api/auth/logout', { headers, data: {} });
    await login(page, 'jamiechen', 'Biology2026!');
    expect((await page.request.get('/api/admin/state')).status()).toBe(403);
    expect((await page.request.get('/api/teacher/state')).status()).toBe(403);
    const publicSetup = await page.request.post('/api/auth/setup', { headers, data: {} });
    expect(publicSetup.status()).toBe(410);
  } finally { await context.close(); }
});
