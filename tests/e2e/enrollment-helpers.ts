import {expect,type Page} from '@playwright/test';
export async function continueRegistration(page:Page){
 await expect(page.getByRole('heading',{name:/Welcome to WaterCycle,/})).toBeVisible();
 const username=await page.getByTestId('assigned-username').innerText();
 await page.screenshot({path:'/tmp/watercycle-registration-confirmation.png',fullPage:true});
 await page.getByRole('button',{name:'Continue to Student Portal',exact:true}).click();
 await page.getByRole('button',{name:"Got It! Let's Go",exact:true}).click();
 return username;
}
export async function joinClass(page:Page,code:string){
 await page.getByRole('button',{name:'+ Join a Class',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Join a Class',exact:true});
 await dialog.getByLabel('Class enrollment code',{exact:true}).fill(code);
 await expect(dialog.getByLabel('Class enrollment code',{exact:true})).toHaveValue(code.toUpperCase());
 await dialog.getByRole('button',{name:'Find Class',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Confirm Join',exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Confirm Join',exact:true}).click();
 await expect(dialog).not.toBeVisible();
}
export async function scheduleClassForm(page:Page){
 const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Class start time',{exact:true}).fill('00:00');
 await dialog.getByLabel('Class end time',{exact:true}).fill('23:59');
}
