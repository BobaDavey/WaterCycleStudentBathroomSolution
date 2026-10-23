import {test as base} from '@playwright/test';
export * from '@playwright/test';
// Both sides of the browser tests share the same advancing school-day offset.
// The app's real startup path never imports these test fixtures.
export const test=base.extend({
 browser:[async({browser},use)=>{
  const original=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await original(options);
   await context.addInitScript(offset=>{
    const NativeDate=Date;
    globalThis.Date=class SchoolDayDate extends NativeDate {
     constructor(...args:ConstructorParameters<typeof Date>){super(...(args.length?args:[NativeDate.now()+offset]) as ConstructorParameters<typeof Date>);}
     static now(){return NativeDate.now()+offset;}
     static parse(value:string){return NativeDate.parse(value);}
     static UTC(...args:Parameters<typeof Date.UTC>){return NativeDate.UTC(...args);}
    } as DateConstructor;
   },Number(process.env.WATERCYCLE_TEST_CLOCK_OFFSET_MS));
   return context;
  };
  try{await use(browser);}finally{browser.newContext=original;}
 },{scope:'worker'}],
});
