import { expect, type Page } from '@playwright/test';
import type { BreakPurpose, Question, Quiz, QuizResult } from '../../src/lib/contracts';

export async function startLearning(page: Page, purpose: BreakPurpose): Promise<Quiz> {
  await page.getByRole('button', { name: 'Request a Break', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: purpose === 'water' ? /Drink Water/ : /Use Restroom/ }).check();
  const response = page.waitForResponse(r => r.url().endsWith('/api/student/quiz') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const started = await response;
  expect(started.status()).toBe(200);
  return await started.json() as Quiz;
}

export async function answerCurrent(page: Page, quiz: Quiz, questions: Question[], correct = true): Promise<QuizResult> {
  const key = questions.find(q => q.id === quiz.question.id);
  expect(key).toBeTruthy();
  await expect(page.locator('fieldset')).toContainText(quiz.question.prompt);
  await page.locator('fieldset').getByRole('radio').nth(correct ? key!.correctIndex : (key!.correctIndex + 1) % 4).check();
  const response = page.waitForResponse(r => r.url().endsWith('/api/student/quiz/answer') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  const checked = await response;
  expect(checked.status()).toBe(200);
  return await checked.json() as QuizResult;
}

export async function qualifyBreak(page: Page, questions: Question[], purpose: BreakPurpose = 'restroom') {
  let quiz = await startLearning(page, purpose);
  const first = await answerCurrent(page, quiz, questions);
  expect(first.correctCount).toBe(1);
  expect(first.passed).toBe(false);
  quiz = first.quiz!;
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  const second = await answerCurrent(page, quiz, questions);
  expect(second.correctCount).toBe(2);
  expect(second.passed).toBe(true);
  expect(second.visit?.purpose).toBe(purpose);
  return second.visit!;
}
