import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { AppError, cookieName, createSession, digest, rateLimit, sessionUser } from '@/lib/auth';
import { WaterCycle, adminProfileSchema, classCreateSchema, classUpdateSchema, enrollmentSchema, loginSchema, passwordSchema, questionSchema, requirePasswordChange, rosterSchema, rosterUpdateSchema, signupSchema, teacherCreateSchema, teacherUpdateSchema, transferSchema } from '@/lib/domain';
import { reportSchema, reportFiltersSchema, reportStatusSchema } from '@/lib/problem-reports';
import { ruleOffendersSchema } from '@/lib/rule-offenders';
import type { User } from '@/lib/contracts';
import { isSameOrigin, usesSecureCookie } from '@/lib/request-security';
import { developmentDiagnostic } from '@/lib/development-diagnostics';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const ok = () => NextResponse.json({ok:true});
const reopenSchema = z.object({resolveOlder:z.boolean().optional(),reason:z.string().trim().max(2000).optional()});
const quizStartSchema = z.object({purpose:z.enum(['restroom','water'],{error:'Choose Use Restroom or Drink Water before continuing.'})});
const answerSchema = z.object({quizId:z.string().uuid(),questionId:z.string().min(1).max(200),questionToken:z.string().uuid(),answer:z.number().int().min(0).max(3)});
const quizCancelSchema = z.object({quizId:z.string().uuid()});
function cookie(response: NextResponse, token:string, request:NextRequest) {
 response.cookies.set(cookieName,token,{httpOnly:true,secure:usesSecureCookie(request.headers.get('origin'),request.nextUrl.protocol,process.env.VERCEL==='1'),sameSite:'lax',path:'/',maxAge:7*86400});
 return response;
}
async function handle(request:NextRequest, context:Context) {
 try {
  if (!['GET','HEAD'].includes(request.method)) {
   if (!isSameOrigin(request.headers.get('origin'),request.headers.get('host'),process.env.VERCEL==='1')) throw new AppError(403,'This request must come from the app’s own page. Please refresh and try again.');
   if (request.method !== 'DELETE' && !(request.headers.get('content-type') || '').includes('application/json')) throw new AppError(415,'Please send JSON.');
   if (Number(request.headers.get('content-length') || 0)>32768) throw new AppError(413,'This request is too large.');
  }
  const {path}=await context.params;
  const route=path.join('/'); const method=request.method;
  if(route==='auth/setup')throw new AppError(410,'Teacher accounts are created by the administrator. Public teacher registration is unavailable.');
  const db=await getDatabase();const app=new WaterCycle(db);const token=request.cookies.get(cookieName)?.value;
  if(route==='health'&&method==='GET'){await db.query('SELECT 1');return NextResponse.json({ok:true});}
  let user=await sessionUser(db,token);
  const classroomId=request.nextUrl.searchParams.get('classroomId') || undefined;
  async function json() {const text=await request.text();if(text.length>32768)throw new AppError(413,'This request is too large.');try{return JSON.parse(text || '{}');}catch{throw new AppError(400,'Please send valid JSON.');}}
  async function authenticated() {if(!user)throw new AppError(401,'Please sign in to continue.');return user;}
  async function signIn(nextUser:User) {const session=await createSession(db,nextUser.id);return cookie(NextResponse.json({user:nextUser}),session,request);}
  if(route==='auth/me'&&method==='GET'){
   const {rows}=await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
   return NextResponse.json({user,setupAvailable:false,adminProvisioned:Boolean(rows.length),...(db.localDevelopment&&process.env.NODE_ENV!=='production'&&!rows.length?{developmentSetup:process.env.DEV_ADMIN_INITIAL_PASSWORD||process.env.ADMIN_INITIAL_PASSWORD?'restart-required':'missing-secret'}:{}),demo:process.env.DEMO_MODE==='true'&&process.env.LOCAL_DATABASE==='true'&&!process.env.DATABASE_URL});
  }
  if(['auth/login','auth/signup'].includes(route)&&method==='POST'){
   const address=request.headers.get('x-vercel-forwarded-for')||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'local';
   await rateLimit(db,`${route}:ip:${digest(address)}`,200);
   const body=await json();
   if(route==='auth/login'){
    const input=loginSchema.parse(body);await rateLimit(db,`login:user:${input.username.toLowerCase()}`);
    const authenticated=await db.transaction(async tx=>{const nextUser=await app.login(input,tx);return{user:nextUser,session:await createSession(tx,nextUser.id)};});
    return cookie(NextResponse.json({user:authenticated.user}),authenticated.session,request);
   }
   return signIn(await app.signup(signupSchema.parse(body)));
  }
  if(route==='auth/logout'&&method==='POST'){
   if(token)await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
   const response=ok();response.cookies.set(cookieName,'',{httpOnly:true,path:'/',maxAge:0,sameSite:'lax',secure:usesSecureCookie(request.headers.get('origin'),request.nextUrl.protocol,process.env.VERCEL==='1')});return response;
  }
  user=await authenticated();
  if(route==='auth/password'&&method==='POST'){
   await rateLimit(db,`password:${user.id}`,12);const input=passwordSchema.parse(await json());await app.changePassword(user,input.currentPassword,input.newPassword);return cookie(ok(),await createSession(db,user.id),request);
  }
  if(route==='student/state'&&method==='GET')return NextResponse.json(await app.studentState(user));
  if(route==='teacher/state'&&method==='GET')return NextResponse.json(await app.teacherState(user,classroomId));
  if(route==='admin/state'&&method==='GET')return NextResponse.json(await app.adminState(user));
  requirePasswordChange(user);
  if(['teacher/violations','admin/violations'].includes(route)&&method==='GET'){if(user.role!==(path[0]==='teacher'?'teacher':'admin'))throw new AppError(403,'You do not have access to these records.');const filters=ruleOffendersSchema.parse(Object.fromEntries(request.nextUrl.searchParams));return NextResponse.json(await app.ruleOffenders(user,filters));}
  if(route==='teacher/reports'&&method==='POST'){if(user.role!=='teacher')throw new AppError(403,'Teacher access required.');await rateLimit(db,`reports:${user.id}`,20);return NextResponse.json(await app.submitReport(user,reportSchema.parse(await json())));}
  if(route==='admin/reports'&&method==='GET')return NextResponse.json(await app.problemReports(user,reportFiltersSchema.parse(Object.fromEntries(request.nextUrl.searchParams))));
  if(path.length===3&&path[0]==='admin'&&path[1]==='reports'){if(method==='GET')return NextResponse.json(await app.problemReport(user,path[2]));if(method==='PATCH'){await app.changeReportStatus(user,path[2],reportStatusSchema.parse(await json()).status);return ok();}}
  if(path.length===4&&path[0]==='teacher'&&path[1]==='visits'&&path[3]==='reopen'&&method==='POST'){await app.reopenVisit(user,path[2],reopenSchema.parse(await json()));return ok();}
  if(route==='student/enroll'&&method==='POST'){await app.enrollStudent(user,enrollmentSchema.parse(await json()).classroomCode);return ok();}
  if(route==='student/quiz'&&method==='POST'){await rateLimit(db,`quiz:${user.id}`,30);const input=quizStartSchema.parse(await json());return NextResponse.json(await app.newQuiz(user,input.purpose));}
  if(route==='student/quiz/answer'&&method==='POST')return NextResponse.json(await app.answerQuiz(user,answerSchema.parse(await json())));
  if(route==='student/quiz/cancel'&&method==='POST'){await app.cancelQuiz(user,quizCancelSchema.parse(await json()).quizId);return ok();}
  if(route==='student/quiz/submit')throw new AppError(410,'This learning screen has changed. Refresh the page to answer one question at a time.');
  if(route==='student/tutorial'&&method==='POST'){await app.completeTutorial(user);return ok();}
  if(path.length===4&&path[0]==='student'&&path[1]==='visits'&&path[3]==='warning'&&method==='POST'){await app.acknowledgeWarning(user,path[2]);return ok();}
  if(['student/leave','student/return','student/cancel'].includes(route)&&method==='POST'){await app.studentAction(user,path[1] as 'leave'|'return'|'cancel');return ok();}
  if(route==='teacher/classes'&&method==='POST')return NextResponse.json({classroom:await app.createClass(user,classCreateSchema.parse(await json()))});
  if(path.length===3&&path[0]==='teacher'&&path[1]==='classes'&&method==='PATCH')return NextResponse.json({classroom:await app.updateClass(user,path[2],classUpdateSchema.parse(await json()))});
  if(route==='teacher/roster'&&method==='POST')return NextResponse.json({student:await app.addRoster(user,rosterSchema.parse(await json()),classroomId)});
  if(path.length===3&&path[0]==='teacher'&&path[1]==='roster'){
   if(method==='GET')return NextResponse.json(await app.rosterDetail(user,path[2],classroomId));
   if(method==='PATCH'){await app.updateRoster(user,path[2],rosterUpdateSchema.parse(await json()));return ok();}
  }
  if(path.length===4&&path[0]==='teacher'&&path[1]==='roster'&&method==='POST'){
   if(path[3]==='remove'){await app.removeStudent(user,path[2]);return ok();}
   if(path[3]==='transfer'){await app.transferStudent(user,path[2],transferSchema.parse(await json()).classroomId);return ok();}
  }
  if(route==='teacher/questions'&&method==='POST')return NextResponse.json({question:await app.saveQuestion(user,questionSchema.parse(await json()),undefined,classroomId)});
  if(path.length===3&&path[0]==='teacher'&&path[1]==='questions'){
   if(method==='PATCH'){await app.saveQuestion(user,questionSchema.parse(await json()),path[2],classroomId);return ok();}
   if(method==='DELETE'){await app.deleteQuestion(user,path[2],classroomId);return ok();}
  }
  if(path.length===4&&path[0]==='teacher'&&path[1]==='visits'&&['return','cancel'].includes(path[3])&&method==='POST'){await app.teacherVisit(user,path[2],path[3] as 'return'|'cancel');return ok();}
  if(route==='teacher/classroom')throw new AppError(410,'Manage class names and enrollment codes from Class Roster.');
  if(route==='teacher/export'&&method==='GET')return new NextResponse(await app.exportCsv(user,classroomId),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="watercycle-trips.csv"','Cache-Control':'no-store'}});
  if(route==='admin/teachers'&&method==='POST')return NextResponse.json({teacher:await app.createTeacher(user,teacherCreateSchema.parse(await json()))});
  if(path.length===3&&path[0]==='admin'&&path[1]==='teachers'&&method==='PATCH'){await app.updateTeacher(user,path[2],teacherUpdateSchema.parse(await json()));return ok();}
  if(path.length===3&&path[0]==='admin'&&path[1]==='classes'&&method==='GET')return NextResponse.json(await app.adminClass(user,path[2]));
  if(route==='admin/profile'&&method==='PATCH'){await app.updateAdminProfile(user,adminProfileSchema.parse(await json()));return ok();}
  throw new AppError(404,'That page or action was not found.');
 }catch(error){
  const diagnostic=developmentDiagnostic(error,process.env);
  if(diagnostic){console.error(diagnostic);return NextResponse.json({error:'Development database setup is unavailable. Check the server terminal and the README troubleshooting steps.'},{status:503,headers:{'Cache-Control':'no-store'}});}
  if(error instanceof AppError)return NextResponse.json({error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
  if(error instanceof z.ZodError)return NextResponse.json({error:error.issues[0]?.message||'Please check your entries.'},{status:400});
  const pg=error as {code?:string;constraint?:string};
  if(pg.code==='23505')return NextResponse.json({error:pg.constraint?.includes('code')?'That five-character enrollment code is already in use. Choose another code.':pg.constraint?.includes('admin')?'Only the single authorized administrator account can exist.':'That username is already registered, or that student already has an enrollment or pass.'},{status:409});
  if(pg.code==='23514')return NextResponse.json({error:pg.constraint?.includes('code')?'Enrollment codes must contain exactly five letters or numbers.':'This change violates an account or classroom rule.'},{status:400});
  console.error('WaterCycle request failed:',error instanceof Error?error.name:'unknown error');
  return NextResponse.json({error:'The server could not complete this request. Please try again or contact your teacher.'},{status:500});
 }
}
export async function GET(request:NextRequest,context:Context){const response=await handle(request,context);response.headers.set('Cache-Control','no-store');return response;}
export const POST=handle;
export const PATCH=handle;
export const DELETE=handle;
