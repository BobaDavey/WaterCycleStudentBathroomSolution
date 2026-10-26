import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SQL} from './db';
import type {Question,QuestionSet,User} from './contracts';
import {AppError} from './auth';

export const questionSetSchema=z.object({name:z.string().trim().min(1).max(100),description:z.string().trim().max(2000).default('')});
export const setMembershipSchema=z.object({questionId:z.string().min(1).max(200),active:z.boolean()});
export const activeSetsSchema=z.object({setIds:z.array(z.string().min(1).max(200)).max(200).refine(ids=>new Set(ids).size===ids.length,'Choose each set once.')});
export const eligibleQuestionPredicate=`q.active=TRUE AND q.deleted=FALSE AND EXISTS(
 SELECT 1 FROM question_set_questions sq JOIN question_sets s ON s.id=sq.set_id AND s.deleted=FALSE
 JOIN classroom_question_sets cs ON cs.set_id=s.id AND cs.classroom_id=$1 AND cs.active=TRUE
 WHERE sq.question_id=q.id AND sq.active=TRUE)`;
const setScope=`(s.teacher_id=$2 OR s.origin_classroom_id=$1 OR EXISTS(SELECT 1 FROM classroom_question_sets cs WHERE cs.set_id=s.id AND cs.classroom_id=$1))`;
const questionScope=`(q.classroom_id=$1 OR EXISTS(SELECT 1 FROM classrooms origin WHERE origin.id=q.classroom_id AND origin.teacher_id=$2)
 OR EXISTS(SELECT 1 FROM question_set_questions sq JOIN question_sets s ON s.id=sq.set_id WHERE sq.question_id=q.id AND sq.active=TRUE AND s.deleted=FALSE AND ${setScope}))`;
export function questionFromRow(row:Record<string,unknown>):Question{return{id:String(row.id),prompt:String(row.prompt),options:row.options as string[],correctIndex:Number(row.correct_index),topic:String(row.topic),explanation:String(row.explanation),active:Boolean(row.active),createdAt:row.created_at?new Date(row.created_at as string).toISOString():null,setIds:(row.set_ids??[]) as string[]};}
export async function defaultQuestionSet(tx:SQL,classroomId:string) {
 const id=`legacy-bank-${classroomId}`;
 await tx.query(`INSERT INTO question_sets(id,teacher_id,origin_classroom_id,name,description)
 SELECT $1,teacher_id,id,left('Existing question bank · '||name,100),'Default questions for '||name FROM classrooms WHERE id=$2 ON CONFLICT(id) DO NOTHING`,[id,classroomId]);
 await tx.query('INSERT INTO classroom_question_sets(classroom_id,set_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[classroomId,id]);
 return id;
}
export async function linkQuestion(tx:SQL,setId:string,questionId:string,active=true){await tx.query('INSERT INTO question_set_questions(set_id,question_id,active) VALUES($1,$2,$3) ON CONFLICT(set_id,question_id) DO UPDATE SET active=EXCLUDED.active',[setId,questionId,active]);}
export async function assertSet(tx:SQL,user:User,classroomId:string,setId:string){
 const {rows:[set]}=await tx.query(`SELECT s.* FROM question_sets s WHERE s.id=$3 AND s.deleted=FALSE AND ${setScope}`,[classroomId,user.id,setId]);
 if(!set)throw new AppError(404,'Question Set not found in this classroom or your library.');return set;
}
export async function assertQuestion(tx:SQL,user:User,classroomId:string,id:string){
 const {rows:[question]}=await tx.query(`SELECT q.* FROM questions q WHERE q.id=$3 AND q.deleted=FALSE AND ${questionScope}`,[classroomId,user.id,id]);
 if(!question)throw new AppError(404,'Question not found in this classroom or your library.');return question;
}
export async function questionLibrary(tx:SQL,user:User,classroomId:string):Promise<{questions:Question[];questionSets:QuestionSet[];activeSetIds:string[];eligibleQuestionCount:number}>{
 const {rows:sets}=await tx.query(`SELECT s.*,
 (SELECT COUNT(*) FROM question_set_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.set_id=s.id AND sq.active=TRUE AND q.deleted=FALSE) AS question_count,
 (SELECT COUNT(*) FROM classroom_question_sets cs WHERE cs.set_id=s.id AND cs.active=TRUE) AS class_count
 FROM question_sets s WHERE s.deleted=FALSE AND ${setScope} ORDER BY s.name,s.id`,[classroomId,user.id]);
 const {rows:questions}=await tx.query(`SELECT q.*,COALESCE((SELECT jsonb_agg(s.id ORDER BY s.id) FROM question_set_questions sq JOIN question_sets s ON s.id=sq.set_id WHERE sq.question_id=q.id AND sq.active=TRUE AND s.deleted=FALSE AND ${setScope}),'[]'::jsonb) AS set_ids FROM questions q WHERE q.deleted=FALSE AND ${questionScope} ORDER BY q.topic,q.prompt,q.id`,[classroomId,user.id]);
 const {rows:active}=await tx.query('SELECT cs.set_id FROM classroom_question_sets cs JOIN question_sets s ON s.id=cs.set_id AND s.deleted=FALSE WHERE cs.classroom_id=$1 AND cs.active=TRUE',[classroomId]);
 const {rows:[count]}=await tx.query(`SELECT COUNT(*) AS n FROM questions q WHERE ${eligibleQuestionPredicate}`,[classroomId]);
 return{questions:questions.map(questionFromRow),questionSets:sets.map(s=>({id:String(s.id),name:String(s.name),description:String(s.description),questionCount:Number(s.question_count),classCount:Number(s.class_count),ownerTeacherId:String(s.teacher_id)})),activeSetIds:active.map(s=>String(s.set_id)),eligibleQuestionCount:Number(count.n)};
}
export async function createQuestionSet(tx:SQL,user:User,classroom:Record<string,unknown>,input:z.infer<typeof questionSetSchema>){
 const id=randomUUID();await tx.query('INSERT INTO question_sets(id,teacher_id,origin_classroom_id,name,description) VALUES($1,$2,$3,$4,$5)',[id,classroom.teacher_id,classroom.id,input.name,input.description]);return{id};
}
