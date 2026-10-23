import { test, expect, type Page } from './fixtures';
import type { RuleOffendersState, TeacherState } from '../../src/lib/contracts';

const origin='http://127.0.0.1:3100';
const headers={Origin:origin,'Content-Type':'application/json'};
async function teacherLogin(page:Page) {
  await page.goto('/');
  await page.getByRole('button',{name:'I’m a teacher',exact:true}).click();
  await page.getByLabel('Username',{exact:true}).fill('morganreed');
  await page.getByLabel('Password',{exact:true}).fill('WaterCycle2026!');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}

test('login has no demo autofill; teacher request is informational and accessible; student registration remains available',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();
  try {
    const posts:string[]=[];
    page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});
    await page.goto('/');
    await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:/Fill.*demo/i})).toHaveCount(0);
    await expect(page.getByLabel('Username',{exact:true})).toHaveValue('');
    await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
    await expect(page.getByRole('link',{name:'Developer sign in',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:/Administrator sign in/i})).toHaveCount(0);
    await page.getByRole('button',{name:'I’m a teacher',exact:true}).click();
    await expect(page.getByRole('button',{name:'Create a student account',exact:true})).toHaveCount(0);
    const request=page.getByRole('button',{name:'Create a teacher account',exact:true});
    await request.click();
    const modal=page.getByRole('dialog',{name:'Teacher Account Registration',exact:true});
    await expect(modal).toBeVisible();
    await expect(modal.locator('#teacher-registration-copy')).toHaveText('This app is still under small scale classroom testing phase, please contact David Zhang (bestbiologuy@gmail.com) to request a teachers account set-up.');
    await expect(modal.getByRole('link',{name:'bestbiologuy@gmail.com',exact:true})).toHaveAttribute('href','mailto:bestbiologuy@gmail.com');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.keyboard.press('Tab');
    expect(await modal.evaluate(element=>element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(request).toBeFocused();
    await request.click();
    await modal.getByRole('button',{name:'Got It',exact:true}).click();
    await expect(modal).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect((await page.request.post('/api/auth/setup',{headers,data:{}})).status()).toBe(410);
    await page.getByRole('button',{name:'I’m a student',exact:true}).click();
    await page.getByRole('button',{name:'Create a student account',exact:true}).click();
    await expect(page.getByRole('button',{name:'Create my account',exact:true})).toBeVisible();
    await expect(page.getByLabel('Classroom code',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Username',{exact:true})).toHaveCount(0);await expect(page.getByText(/automatically assigns a unique username/)).toBeVisible();
  }finally{await context.close();}
});

test('developer sign-in starts blank and requires manual credentials for the automatically initialized development account',async({page})=>{
  await page.goto('/');
  await page.getByRole('link',{name:'Developer sign in',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  const username=page.getByLabel('Developer username',{exact:true});
  await expect(username).toHaveValue('');
  await expect(username).not.toHaveAttribute('readonly');
  await expect(username).not.toHaveAttribute('placeholder',/david/i);
  await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('davidanzezhang');
  await username.fill('not-the-developer');
  await page.getByLabel('Password',{exact:true}).fill(process.env.WATERCYCLE_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button',{name:'Developer Sign In',exact:true}).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('username or password is incorrect');
  await username.fill('davidanzezhang');
  await page.getByRole('button',{name:'Developer Sign In',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole('navigation',{name:'Administrator navigation'})).toBeVisible();
  const oversight=await page.request.get('/api/admin/violations');
  expect(oversight.status()).toBe(200);
  expect((await oversight.json() as RuleOffendersState).violations.some(row=>row.id==='e2e-other-teacher')).toBe(true);
});

test('Rule Offenders uses existing history with search, class filters, local timezones, stable totals and private teacher scope',async({page})=>{
  await teacherLogin(page);
  const teacher=await(await page.request.get('/api/teacher/state')).json() as TeacherState;
  const one=teacher.classes.find(c=>c.code==='01001')!;
  await page.getByRole('button',{name:'Trip history',exact:true}).click();
  await expect(page.getByRole('button',{name:'Rule Offenders',exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'Rule Offenders',exact:true}).click();
  const region=page.getByRole('region',{name:'Rule Offenders records',exact:true});
  await expect(region).toBeVisible();
  const rows=region.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute('data-violation-id','e2e-other-period');
  const jamie=rows.filter({hasText:'Jamie Chen'});
  await expect(jamie).toHaveCount(2);
  for(const row of await jamie.all())await expect(row.locator('td').last()).toHaveText('2');
  await expect(region).not.toContainText('Other teacher');
  expect((await page.request.get('/api/admin/violations')).status()).toBe(403);
  await page.getByLabel('Filter rule offenders by class',{exact:true}).selectOption(one.id);
  await expect(rows).toHaveCount(2);
  await expect(region).toContainText('USA / Eastern');
  await expect(region).not.toContainText('America/New_York');
  const api=await(await page.request.get(`/api/teacher/violations?classroomId=${one.id}`)).json() as RuleOffendersState;
  const local=new Intl.DateTimeFormat('en-US',{timeZone:one.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(api.violations[0].violatedAt));
  await expect(rows.first().locator('time')).toHaveText(local);
  await page.getByLabel('Search rule offenders',{exact:true}).fill('no matching learner');
  await expect(page.getByRole('heading',{name:'No rule violations recorded.',exact:true})).toBeVisible();
  await page.getByLabel('Search rule offenders',{exact:true}).fill('jAmIe');
  await expect(region).toBeVisible();await expect(rows).toHaveCount(2);
  await page.reload();
  await page.getByRole('button',{name:'Trip history',exact:true}).click();
  await page.getByRole('tab',{name:'Rule Offenders',exact:true}).click();
  await expect(page.getByRole('region',{name:'Rule Offenders records'}).locator('tbody tr')).toHaveCount(3);
  const refreshed=await(await page.request.get('/api/teacher/violations')).json() as RuleOffendersState;
  expect(refreshed.violations.filter(row=>row.studentName==='Jamie Chen')).toHaveLength(2);
  expect(refreshed.violations.every(row=>row.id!=='e2e-other-teacher')).toBe(true);
});
