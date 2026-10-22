import { test, expect, type Page } from '@playwright/test';
import type { Question, Quiz, QuizResult, StudentState, TeacherState } from '../../src/lib/contracts';

async function login(page: Page, username: string, password: string, teacher = false) {
  await page.goto('/');
  await page.getByRole('button', { name: teacher ? 'I’m a teacher' : 'I’m a student' }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function requestPass(page: Page, questions: Question[]) {
  await page.getByRole('button', { name: 'Request a Break', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: /Use Restroom/ }).check();
  const response = page.waitForResponse(r => r.url().endsWith('/api/student/quiz') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  let quiz = await (await response).json() as Quiz;
  expect(quiz.purpose).toBe('restroom');
  expect(quiz.correctCount).toBe(0);
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) {
    expect(quiz.question).not.toHaveProperty('correctIndex');
    expect(seen.has(quiz.question.id)).toBe(false);
    seen.add(quiz.question.id);
    await expect(page.getByText(`Correct Answers: ${i}/2`, { exact: true })).toBeVisible();
    const answer = questions.find(q => q.id === quiz.question.id)!;
    expect(answer).toBeTruthy();
    await page.locator('fieldset').getByRole('radio').nth(answer.correctIndex).check();
    const checked = page.waitForResponse(r => r.url().endsWith('/api/student/quiz/answer') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Check Answer', exact: true }).click();
    const result = await (await checked).json() as QuizResult;
    expect(result.correctCount).toBe(i + 1);
    expect(result.passed).toBe(i === 1);
    if (i === 0) {
      expect(result.visit).toBeUndefined();
      expect(result.quiz).toBeTruthy();
      quiz = result.quiz!;
    }
  }
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
    await expect(first.getByRole('heading', { name: 'Your time is NOW, GRAB A PASS', exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: "I'm Back", exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: "I'm Leaving Now", exact: true })).toHaveCount(0);
    const immediate = await (await first.request.get('/api/student/state')).json() as StudentState;
    expect(immediate.currentVisit?.status).toBe('out');
    expect(immediate.currentVisit?.leftAt).toBeTruthy();
    expect(immediate.currentVisit?.purpose).toBe('restroom');
    await requestPass(second, state.questions);
    await expect(second.getByRole('button', { name: "I'm Back", exact: true })).toBeVisible();
    expect(((await (await second.request.get('/api/student/state')).json()) as StudentState).currentVisit?.leftAt).toBeTruthy();
    await requestPass(third, state.questions);
    await expect(third.getByRole('heading', { name: "You're in line!", exact: true })).toBeVisible();
    await expect(third.getByText('Your position: #1', { exact: true })).toBeVisible();
    const waiting = await (await third.request.get('/api/student/state')).json() as StudentState;
    expect(waiting.currentVisit?.position).toBe(1);
    expect(waiting.currentVisit?.status).toBe('waiting');
    expect(waiting.currentVisit?.leftAt).toBeNull();
    expect(waiting.activeCount).toBe(2);
    expect(waiting).not.toHaveProperty('students');
    await first.getByRole('button', { name: "I'm Back", exact: true }).click();
    await expect(third.getByRole('heading', { name: "It's your turn! You're cleared to go.", exact: true })).toBeVisible();
    await expect(third).toHaveTitle(/your turn/i);
    const reserved = await (await third.request.get('/api/student/state')).json() as StudentState;
    expect(reserved.currentVisit?.status).toBe('ready');
    expect(reserved.currentVisit?.leftAt).toBeNull();
    expect(reserved.currentVisit?.readyExpiresAt).toBeTruthy();
    expect(reserved.activeCount).toBe(2);
    await third.getByRole('button', { name: "I'm Leaving Now", exact: true }).click();
    const departed = await (await third.request.get('/api/student/state')).json() as StudentState;
    expect(departed.currentVisit?.status).toBe('out');
    expect(departed.currentVisit?.leftAt).toBeTruthy();
    await third.getByRole('button', { name: "I'm Back", exact: true }).click();
    await second.getByRole('button', { name: "I'm Back", exact: true }).click();
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
  await page.getByLabel('Classroom code').fill('01001');
  await page.getByLabel('Password', { exact: true }).fill('MyBiology2026!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: /Hey, Robin/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome to WaterCycle', exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Got It! Let's Go", exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(((await (await page.request.get('/api/auth/me')).json()) as { user: { tutorialCompleted: boolean } }).user.tutorialCompleted).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await login(page, `robin${lastName}`.toLowerCase(), 'MyBiology2026!');
  await expect(page.getByRole('heading', { name: /Hey, Robin/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome to WaterCycle', exact: true })).toHaveCount(0);
});

test('sign-in works on a narrow mobile screen without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page, 'jamiechen', 'Biology2026!');
    await expect(page.getByRole('button', { name: 'Request a Break', exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: 'Class Roster', exact: true }).click();
    await page.getByRole('article').filter({ hasText: '01001' }).getByRole('button', { name: 'View Class', exact: true }).click();
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
      await claim.getByLabel('Classroom code').fill('01001');
      await claim.getByLabel('Password', { exact: true }).fill('FirstBiology2026!');
      await claim.getByRole('button', { name: 'Create my account' }).click();
      await expect(claim.getByRole('heading', { name: /Hey, Rosa/ })).toBeVisible();
      await claim.getByRole('button', { name: "Got It! Let's Go", exact: true }).click();
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
      await expect(studentPage.getByRole('button', { name: 'Request a Break', exact: true })).toBeVisible();
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
