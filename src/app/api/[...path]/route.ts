import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { AppError, cookieName, createSession, digest, rateLimit, sessionUser } from '@/lib/auth';
import { WaterCycle, classroomSchema, loginSchema, passwordSchema, questionSchema, requirePasswordChange, rosterSchema, rosterUpdateSchema, setupSchema, signupSchema, submitSchema } from '@/lib/domain';
import type { User } from '@/lib/contracts';
import { isSameOrigin, usesSecureCookie } from '@/lib/request-security';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const ok = () => NextResponse.json({ok:true});
function cookie(response: NextResponse, token:string, request:NextRequest) {
 response.cookies.set(cookieName,token,{httpOnly:true,secure:usesSecureCookie(request.headers.get('origin'),request.nextUrl.protocol,process.env.VERCEL==='1'),sameSite:'lax',path:'/',maxAge:7*86400});
 return response;
}
async function handle(request:NextRequest, context:Context) {
 try {
  if (!['GET','HEAD'].includes(request.method)) {
   const origin=request.headers.get('origin');
   // Same-origin browser requests only; origin-less non-browser clients must explicitly send this header too.
   if (!isSameOrigin(origin,request.headers.get('host'),process.env.VERCEL==='1')) throw new AppError(403,'This request must come from the app’s own page. Please refresh and try again.');
   const type=request.headers.get('content-type') || '';
   if (request.method !== 'DELETE' && !type.includes('application/json')) throw new AppError(415,'Please send JSON.');
   if (Number(request.headers.get('content-length') || 0)>32768) throw new AppError(413,'This request is too large.');
  }
  const {path}=await context.params;
  const route=path.join('/');
  const method=request.method;
  const db=await getDatabase();
  const app=new WaterCycle(db);
  const token=request.cookies.get(cookieName)?.value;
  let user=await sessionUser(db,token);
  async function json() { const text=await request.text(); if (text.length>32768) throw new AppError(413,'This request is too large.'); try { return JSON.parse(text || '{}'); } catch { throw new AppError(400,'Please send valid JSON.'); } }
  async function authenticated() { if (!user) throw new AppError(401,'Please sign in to continue.'); return user; }
  async function signIn(nextUser:User) { const session=await createSession(db,nextUser.id); return cookie(NextResponse.json({user:nextUser}),session,request); }
  if (route==='auth/me' && method==='GET') {
   const {rows}=await db.query("SELECT id FROM users WHERE role='teacher' LIMIT 1");
   return NextResponse.json({user,setupAvailable:!rows.length,demo:process.env.DEMO_MODE==='true' && process.env.LOCAL_DATABASE==='true' && !process.env.DATABASE_URL});
  }
  if (['auth/login','auth/signup','auth/setup'].includes(route) && method==='POST') {
   // IP is supplied by Vercel's trusted edge in production. A shared fallback is deliberately conservative locally.
   const address=request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
   await rateLimit(db,`${route}:ip:${digest(address)}`,route==='auth/setup'?10:200);
   const body=await json();
   if (route==='auth/login') {
    const input=loginSchema.parse(body);
    await rateLimit(db,`login:user:${input.username.toLowerCase()}`);
    const authenticated = await db.transaction(async tx => {
     const nextUser = await app.login(input,tx);
     const session = await createSession(tx,nextUser.id);
     return { user:nextUser, session };
    });
    return cookie(NextResponse.json({user:authenticated.user}),authenticated.session,request);
   }
   if (route==='auth/signup') return signIn(await app.signup(signupSchema.parse(body)));
   return signIn(await app.setup(setupSchema.parse(body)));
  }
  if (route==='auth/logout' && method==='POST') {
   if (token) await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
   const response=ok(); response.cookies.set(cookieName,'',{httpOnly:true,path:'/',maxAge:0,sameSite:'lax',secure:usesSecureCookie(request.headers.get('origin'),request.nextUrl.protocol,process.env.VERCEL==='1')}); return response;
  }
  user=await authenticated();
  if (route==='auth/password' && method==='POST') {
   await rateLimit(db,`password:${user.id}`,12);
   const input=passwordSchema.parse(await json());
   await app.changePassword(user,input.currentPassword,input.newPassword);
   const session=await createSession(db,user.id);
   return cookie(ok(),session,request);
  }
  // State is still available so clients can show the forced password-change form.
  if (route==='student/state' && method==='GET') return NextResponse.json(await app.studentState(user));
  if (route==='teacher/state' && method==='GET') return NextResponse.json(await app.teacherState(user));
  requirePasswordChange(user);
  if (route==='student/quiz' && method==='POST') { await rateLimit(db,`quiz:${user.id}`,30); return NextResponse.json(await app.newQuiz(user)); }
  if (route==='student/quiz/submit' && method==='POST') { const input=submitSchema.parse(await json()); return NextResponse.json(await app.submitQuiz(user,input.quizId,input.answers)); }
  if (['student/leave','student/return','student/cancel'].includes(route) && method==='POST') { await app.studentAction(user,path[1] as 'leave'|'return'|'cancel'); return ok(); }
  if (route==='teacher/roster' && method==='POST') return NextResponse.json({student:await app.addRoster(user,rosterSchema.parse(await json()))});
  if (path.length===3 && path[0]==='teacher' && path[1]==='roster' && method==='PATCH') { await app.updateRoster(user,path[2],rosterUpdateSchema.parse(await json())); return ok(); }
  if (route==='teacher/questions' && method==='POST') return NextResponse.json({question:await app.saveQuestion(user,questionSchema.parse(await json()))});
  if (path.length===3 && path[0]==='teacher' && path[1]==='questions') {
   if (method==='PATCH') { await app.saveQuestion(user,questionSchema.parse(await json()),path[2]); return ok(); }
   if (method==='DELETE') { await app.deleteQuestion(user,path[2]); return ok(); }
  }
  if (path.length===4 && path[0]==='teacher' && path[1]==='visits' && ['return','cancel'].includes(path[3]) && method==='POST') { await app.teacherVisit(user,path[2],path[3] as 'return'|'cancel'); return ok(); }
  if (route==='teacher/classroom' && method==='PATCH') return NextResponse.json({classroom:await app.updateClassroom(user,classroomSchema.parse(await json()))});
  if (route==='teacher/export' && method==='GET') return new NextResponse(await app.exportCsv(user),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="watercycle-trips.csv"','Cache-Control':'no-store'}});
  throw new AppError(404,'That page or action was not found.');
 } catch(error) {
  if (error instanceof AppError) return NextResponse.json({error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
  if (error instanceof z.ZodError) return NextResponse.json({error:error.issues[0]?.message || 'Please check your entries.'},{status:400});
  if ((error as {code?:string})?.code==='23505') return NextResponse.json({error:'That username is already in use, or you already have an active pass. Please refresh and try again.'},{status:409});
  // Do not expose database URLs, SQL details, or configuration values to the browser.
  console.error('WaterCycle request failed:', error instanceof Error ? error.name : 'unknown error');
  return NextResponse.json({error:'The server could not complete this request. Please try again or contact your teacher.'},{status:500});
 }
}
export async function GET(request:NextRequest,context:Context){const response=await handle(request,context);response.headers.set('Cache-Control','no-store');return response;}
export const POST=handle;
export const PATCH=handle;
export const DELETE=handle;
