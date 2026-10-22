import { test, expect, type Page } from '@playwright/test';
import type { StudentState, TeacherState } from '../../src/lib/contracts';
import { answerCurrent, qualifyBreak, startLearning } from './break-helpers';

const origin = 'http://127.0.0.1:3100';
const headers = { Origin: origin, 'Content-Type': 'application/json' };
async function login(page: Page, username: string, teacher = false) {
  await page.goto('/');
  await page.getByRole('button', { name: teacher ? 'I’m a teacher' : 'I’m a student', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(teacher ? 'WaterCycle2026!' : 'Biology2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
async function finishActive(page: Page) {
  const response = await page.request.get('/api/student/state');
  if (!response.ok()) return;
  const state = await response.json() as StudentState;
  if (state.currentVisit) await page.request.post(`/api/student/${state.currentVisit.status === 'out' ? 'return' : 'cancel'}`, { headers, data: {} });
  else if (state.activeQuiz) await page.request.post('/api/student/quiz/cancel', { headers, data: { quizId: state.activeQuiz.id } });
}

test('purpose-first learning keeps cumulative progress after a wrong answer and refresh; immediate timer and purpose persist', async ({ browser }) => {
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  try {
    await login(teacher, 'morganreed', true);
    const bank = (await (await teacher.request.get('/api/teacher/state')).json() as TeacherState).questions;
    await login(student, 'jamiechen');
    const invalid = await student.request.post('/api/student/quiz', { headers, data: {} });
    expect(invalid.status()).toBe(400);
    let quiz = await startLearning(student, 'water');
    const seen = new Set([quiz.question.id]);
    const first = await answerCurrent(student, quiz, bank);
    expect(first.correctCount).toBe(1);
    expect(first.passed).toBe(false);
    quiz = first.quiz!;
    expect(seen.has(quiz.question.id)).toBe(false);
    seen.add(quiz.question.id);
    await student.getByRole('button', { name: 'Next question', exact: true }).click();
    const wrong = await answerCurrent(student, quiz, bank, false);
    expect(wrong.correctCount).toBe(1);
    expect(wrong.passed).toBe(false);
    expect(wrong.feedback[0].correct).toBe(false);
    quiz = wrong.quiz!;
    expect(seen.has(quiz.question.id)).toBe(false);
    const saved = await (await student.request.get('/api/student/state')).json() as StudentState;
    expect(saved.currentVisit).toBeNull();
    expect(saved.activeQuiz?.correctCount).toBe(1);
    expect(saved.activeQuiz?.purpose).toBe('water');
    expect(JSON.stringify(saved.activeQuiz)).not.toContain('correctIndex');
    await student.reload();
    await expect(student.getByText('Correct Answers: 1/2', { exact: true })).toBeVisible();
    expect(await student.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const resumed = (await (await student.request.get('/api/student/state')).json() as StudentState).activeQuiz!;
    expect(resumed.id).toBe(quiz.id);
    expect(resumed.questionToken).toBe(quiz.questionToken);
    const qualified = await answerCurrent(student, resumed, bank);
    expect(qualified.correctCount).toBe(2);
    expect(qualified.visit?.status).toBe('out');
    expect(qualified.visit?.purpose).toBe('water');
    await expect(student.getByRole('heading', { name: 'Your time is NOW, GRAB A PASS', exact: true })).toBeVisible();
    await expect(student.getByText('Remember: You must return to class within 10 minutes.', { exact: true })).toBeVisible();
    await expect(student.getByLabel('Elapsed break time', { exact: true })).toHaveText(/\d{2}:\d{2}/);
    await expect(student.getByRole('button', { name: "I'm Leaving Now", exact: true })).toHaveCount(0);
    const active = (await (await student.request.get('/api/student/state')).json() as StudentState).currentVisit!;
    expect(active.leftAt).toBeTruthy();
    await student.reload();
    await expect(student.getByRole('heading', { name: 'Your time is NOW, GRAB A PASS', exact: true })).toBeVisible();
    const reopened = (await (await student.request.get('/api/student/state')).json() as StudentState).currentVisit!;
    expect(reopened.id).toBe(active.id);
    expect(reopened.leftAt).toBe(active.leftAt);
    expect(await student.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const teacherState = await (await teacher.request.get('/api/teacher/state')).json() as TeacherState;
    expect(teacherState.visits.find(v => v.id === active.id)?.purpose).toBe('water');
    await student.getByRole('button', { name: "I'm Back", exact: true }).click();
    await expect(student.getByRole('button', { name: 'Request a Break', exact: true })).toBeVisible();
    const history = await (await student.request.get('/api/student/state')).json() as StudentState;
    expect(history.recentVisits[0].id).toBe(active.id);
    expect(history.recentVisits[0].purpose).toBe('water');
    expect(history.recentVisits[0].returnedAt).toBeTruthy();
    await student.getByRole('button', { name: 'How Breaks Work', exact: true }).click();
    const guide = student.getByRole('dialog', { name: 'Welcome to WaterCycle', exact: true });
    const bounds = await guide.boundingBox();
    expect(bounds).toBeTruthy();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.height).toBeLessThanOrEqual(844);
    await expect(guide.getByRole('heading', { name: 'Request a Break', exact: true })).toBeVisible();
    await expect(guide.getByRole('heading', { name: 'Return to Class', exact: true })).toBeVisible();
    await guide.getByRole('button', { name: "Got It! Let's Go", exact: true }).click();
    await expect(guide).not.toBeVisible();
  } finally { await finishActive(student); await teacherContext.close(); await studentContext.close(); }
});

test('10-minute reminder and once-per-break 12-minute warning retain the timer and return action', async ({ browser }) => {
  const context = await browser.newContext();
  const teacherContext = await browser.newContext();
  const page = await context.newPage();
  const teacher = await teacherContext.newPage();
  try {
    await login(teacher, 'morganreed', true);
    const bank = (await (await teacher.request.get('/api/teacher/state')).json() as TeacherState).questions;
    await login(page, 'alexrivera');
    const visit = await qualifyBreak(page, bank);
    expect(visit.status).toBe('out');
    // Drive the browser's elapsed-time presentation through state fixtures.
    // Server-side warning eligibility and persistence are tested against SQL separately.
    let start = Date.now() - 10 * 60000 - 1000;
    let acknowledged = false;
    let acknowledgments = 0;
    await page.route('**/api/student/state', async route => {
      const response = await route.fetch();
      const state = await response.json() as StudentState;
      if (state.currentVisit?.id === visit.id) {
        state.currentVisit.leftAt = new Date(start).toISOString();
        state.currentVisit.warningAcknowledgedAt = acknowledged ? new Date().toISOString() : null;
      }
      state.serverNow = new Date().toISOString();
      await route.fulfill({ response, json: state });
    });
    await page.route(`**/api/student/visits/${visit.id}/warning`, async route => {
      expect(route.request().method()).toBe('POST');
      acknowledged = true; acknowledgments++;
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await page.reload();
    await expect(page.getByText(/You've reached the 10-minute limit/)).toBeVisible();
    await expect(page.getByLabel('Elapsed break time', { exact: true })).toHaveText(/^10:/);
    await expect(page.getByRole('dialog', { name: 'Your Break Has Exceeded 12 Minutes!', exact: true })).toHaveCount(0);
    start = Date.now() - 12 * 60000 - 1000;
    await page.reload();
    const warning = page.getByRole('dialog', { name: 'Your Break Has Exceeded 12 Minutes!', exact: true });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Bathroom breaks should last no longer than 10 minutes. If you exceed the 10-minute limit again, you may lose your break privileges for one month.');
    await expect(warning.getByRole('button', { name: "I'm Back", exact: true })).toBeVisible();
    await expect(warning).toContainText(/12:\d{2}/);
    await warning.getByRole('button', { name: 'Got It', exact: true }).click();
    await expect(warning).not.toBeVisible();
    expect(acknowledgments).toBe(1);
    await page.reload();
    await expect(page.getByLabel('Elapsed break time', { exact: true })).toHaveText(/^12:/);
    await expect(warning).toHaveCount(0);
    await page.getByRole('button', { name: "I'm Back", exact: true }).click();
    await expect(page.getByRole('button', { name: 'Request a Break', exact: true })).toBeEnabled();
    const state = await (await page.request.get('/api/student/state')).json() as StudentState;
    expect(state.currentVisit).toBeNull();
    expect(state.recentVisits[0].status).toBe('returned');
    expect(state.canRequestPass).toBe(true);
    expect(acknowledgments).toBe(1);
  } finally { await finishActive(page); await context.close(); await teacherContext.close(); }
});
