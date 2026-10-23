import { test,expect } from '@playwright/test';

test('development provisioning explains automatic secret setup without prefilling credentials or requesting production bootstrap',async({page})=>{
 await page.route('**/api/auth/me',route=>route.fulfill({json:{user:null,adminProvisioned:false,developmentSetup:'missing-secret'}}));
 await page.goto('/admin/login');
 await expect(page.getByRole('status')).toContainText('DEV_ADMIN_INITIAL_PASSWORD');
 await expect(page.getByRole('status')).toContainText('Setup creates the account automatically');
 await expect(page.getByRole('status')).not.toContainText('admin:bootstrap');
 await expect(page.getByLabel('Developer username',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
 await expect(page.getByRole('button',{name:'Developer Sign In',exact:true})).toBeDisabled();
});
test('hosted unprovisioned developer page shows owner guidance without local secret instructions',async({page})=>{
 await page.route('**/api/auth/me',route=>route.fulfill({json:{user:null,adminProvisioned:false}}));
 await page.goto('/admin/login');
 await expect(page.getByRole('status')).toContainText('Contact the deployment owner');
 await expect(page.getByRole('status')).not.toContainText('ADMIN_INITIAL_PASSWORD');
});
