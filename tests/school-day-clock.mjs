// Test-process instrumentation only: production and npm run dev never import it.
// One shared offset lets the real server/database clock advance normally across
// process restarts while integration tests consistently run on a school morning.
const offset=Number(process.env.WATERCYCLE_TEST_CLOCK_OFFSET_MS);
if(!Number.isSafeInteger(offset))throw new Error('School-day clock fixture requires its explicit test offset.');
const RealDate=Date;
globalThis.Date=class SchoolDayDate extends RealDate {
 constructor(...args){super(...(args.length?args:[RealDate.now()+offset]));}
 static now(){return RealDate.now()+offset;}
 static parse(value){return RealDate.parse(value);}
 static UTC(...args){return RealDate.UTC(...args);}
};
