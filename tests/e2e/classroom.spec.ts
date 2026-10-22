import { test, expect, type Page } from '@playwright/test';
import type { Question, Quiz, StudentState, TeacherState } from '../../src/lib/contracts';

async function login(page: Page, username: string, password: string, teacher = false) {
  await page.goto('/');
  await page.getByRole('button', { name: teacher ? 'I’m a teacher' : 'I’m a student' }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function requestPass(page: Page, questions: Question[]) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/student/quiz') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Request a bathroom pass' }).click();
  const quiz = await (await response).json() as Quiz;
  expect(quiz.questions).toHaveLength(2);
  expect(quiz.questions[0]).not.toHaveProperty('correctIndex');
  expect(quiz.questions[0].id).not.toBe(quiz.questions[1].id);
  for (let i = 0; i < 2; i++) {
    const answer = questions.find(q => q.id === quiz.questions[i].id)!;
    await page.locator('fieldset').nth(i).getByRole('radio').nth(answer.correctIndex).check();
  }
  await page.getByRole('button', { name: 'Check my answers' }).click();
}

test('three students: quiz gate, two spaces, FIFO alert, departure and return records', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  try {
    const [teacher, first, second, third] = await Promise.all(contexts.map(c => c.newPage()));
    await login(teacher, 'morganreed', 'WaterCycle2026!', true);
    const state = await (await teacher.request.get('/api/teacher/state')).json() as TeacherState;
    // Recover from an interrupted previous browser run without erasing history.
    for (const visit of state.visits.filter(v => ['ready', 'waiting', 'out'].includes(v.status))) {
      await teacher.request.post(`/api/teacher/visits/${visit.id}/${visit.status === 'out' ? 'return' : 'cancel'}`, { headers: { Origin: 'http://127.0.0.1:3100', 'Content-Type': 'application/json' }, data: {} });
    }
    await login(first, 'jamiechen', 'Biology2026!');
    await login(second, 'alexrivera', 'Biology2026!');
    await login(third, 'sampatel', 'Biology2026!');
    expect((await first.request.get('/api/teacher/state')).status()).toBe(403);
    await requestPass(first, state.questions);
    await expect(first.getByRole('heading', { name: "It's your turn!" })).toBeVisible();
    await first.getByRole('button', { name: "I'm leaving" }).click();
    await expect(first.getByRole('button', { name: "I'm back" })).toBeVisible();
    await requestPass(second, state.questions);
    await second.getByRole('button', { name: "I'm leaving" }).click();
    await requestPass(third, state.questions);
    await expect(third.getByRole('heading', { name: 'Your break is on its way.' })).toBeVisible();
    const waiting = await (await third.request.get('/api/student/state')).json() as StudentState;
    expect(waiting.currentVisit?.position).toBe(1);
    expect(waiting.activeCount).toBe(2);
    expect(waiting).not.toHaveProperty('students');
    await first.getByRole('button', { name: "I'm back" }).click();
    await expect(third.getByRole('heading', { name: "It's your turn!" })).toBeVisible();
    await expect(third).toHaveTitle(/your turn/i);
    await third.getByRole('button', { name: "I'm leaving" }).click();
    await third.getByRole('button', { name: "I'm back" }).click();
    await second.getByRole('button', { name: "I'm back" }).click();
    const returned = await (await first.request.get('/api/student/state')).json() as StudentState;
    expect(returned.currentVisit).toBeNull();
    expect(returned.recentVisits[0].leftAt).toBeTruthy();
    expect(returned.recentVisits[0].returnedAt).toBeTruthy();
    expect(new Date(returned.recentVisits[0].returnedAt!).getTime()).toBeGreaterThanOrEqual(new Date(returned.recentVisits[0].leftAt!).getTime());
    const finalState = await (await teacher.request.get('/api/teacher/state')).json() as TeacherState;
    expect(finalState.stats.out).toBe(0);
    expect(finalState.stats.ready).toBe(0);
    expect(finalState.stats.waiting).toBe(0);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test('first-time student signup can sign back in using first+last username', async ({ page }) => {
  const lastName = `Test${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: /Create a student account/ }).click();
  await page.getByLabel('First name', { exact: true }).fill('Robin');
  await page.getByLabel('Last name', { exact: true }).fill(lastName);
  await page.getByLabel('Classroom code').fill('BIO2026');
  await page.getByLabel('Password', { exact: true }).fill('MyBiology2026!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: /Hey, Robin/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await login(page, `robin${lastName}`.toLowerCase(), 'MyBiology2026!');
  await expect(page.getByRole('heading', { name: /Hey, Robin/ })).toBeVisible();
});

test('sign-in works on a narrow mobile screen without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page, 'jamiechen', 'Biology2026!');
    await expect(page.getByRole('button', { name: 'Request a bathroom pass' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('teacher manages a roster account and question bank, then exports trip history', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const surname = `Account${Date.now()}`;
  const studentUsername = `rosa${surname}`.toLowerCase();
  try {
    await login(page, 'morganreed', 'WaterCycle2026!', true);
    await page.getByRole('button', { name: 'Student roster', exact: true }).click();
    await page.getByRole('button', { name: 'Add student', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('First name', { exact: true }).fill('Rosa');
    await dialog.getByLabel('Last name', { exact: true }).fill(surname);
    await dialog.getByRole('button', { name: 'Add student', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const student = page.getByRole('row').filter({ hasText: studentUsername });
    await expect(student).toBeVisible();
    // Students claim their roster entry and choose their own first password.
    const claimContext = await browser.newContext();
    try {
      const claim = await claimContext.newPage();
      await claim.goto('/');
      await claim.getByRole('button', { name: /Create a student account/ }).click();
      await claim.getByLabel('First name', { exact: true }).fill('Rosa');
      await claim.getByLabel('Last name', { exact: true }).fill(surname);
      await claim.getByLabel('Classroom code').fill('BIO2026');
      await claim.getByLabel('Password', { exact: true }).fill('FirstBiology2026!');
      await claim.getByRole('button', { name: 'Create my account' }).click();
      await expect(claim.getByRole('heading', { name: /Hey, Rosa/ })).toBeVisible();
    } finally { await claimContext.close(); }
    await student.getByRole('button', { name: /Reset password/i }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Temporary password').fill('Temporary2026!');
    await dialog.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const studentContext = await browser.newContext();
    try {
      const studentPage = await studentContext.newPage();
      await login(studentPage, studentUsername, 'Temporary2026!');
      await expect(studentPage.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
      await studentPage.getByLabel('Temporary password').fill('Temporary2026!');
      await studentPage.getByLabel('New password', { exact: true }).fill('MyOwnBiology2026!');
      await studentPage.getByRole('button', { name: 'Save new password' }).click();
      await expect(studentPage.getByRole('button', { name: 'Request a bathroom pass' })).toBeVisible();
    } finally { await studentContext.close(); }
    await page.getByRole('button', { name: 'Question bank', exact: true }).click();
    await page.getByRole('button', { name: 'Add question', exact: true }).click();
    dialog = page.getByRole('dialog');
    const prompt = `Which organelle contains DNA? ${Date.now()}`;
    await dialog.getByLabel('Question', { exact: true }).fill(prompt);
    await dialog.getByLabel('Topic', { exact: true }).fill('Cell biology');
    for (const [i, option] of ['Nucleus', 'Ribosome', 'Cell wall', 'Vacuole'].entries()) {
      await dialog.getByRole('textbox', { name: `Answer option ${String.fromCharCode(65 + i)}`, exact: true }).fill(option);
    }
    await dialog.getByRole('button', { name: 'Add question', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const question = page.getByRole('article').filter({ has: page.getByRole('heading', { name: prompt, exact: true }) });
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Topic', { exact: true }).fill('Genetics');
    await page.getByRole('dialog').getByRole('button', { name: 'Save question', exact: true }).click();
    await expect(question.getByText('Genetics', { exact: true })).toBeVisible();
    await question.getByRole('button', { name: /Delete question:/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete question', exact: true }).click();
    await expect(question).not.toBeVisible();
    await page.getByRole('button', { name: 'Trip history', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export all CSV', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/watercycle-trips.*\.csv/);
    const stream = await download.createReadStream();
    const chunks = []; for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain('Student');
  } finally { await context.close(); }
});
