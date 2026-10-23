import { effectiveTimeZone } from './time-zones';

export interface ClassSchedule { startTime: string | null; endTime: string | null; scheduleDays: readonly number[]; timeZone: string; }
const formatters=new Map<string,Intl.DateTimeFormat>();
/** Local wall-clock schedules use server instants; start inclusive, end exclusive. */
export function isClassInSession(schedule: ClassSchedule, now: Date): boolean {
 if (!schedule.startTime || !schedule.endTime) return false;
 const zone=effectiveTimeZone(schedule.timeZone);
 let formatter=formatters.get(zone);
 if(!formatter){formatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>=128)formatters.delete(formatters.keys().next().value!);formatters.set(zone,formatter);}
 const parts=formatter.formatToParts(now);
 const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item=>item.type===type)!.value;
 const day = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(part('weekday'))+1;
 const clock = `${part('hour')}:${part('minute')}`;
 return schedule.scheduleDays.includes(day) && clock >= schedule.startTime && clock < schedule.endTime;
}
export function scheduleLabel(schedule: ClassSchedule): string {
 if (!schedule.startTime || !schedule.endTime) return 'Schedule needed';
 const time = (value: string) => {const [h,m]=value.split(':').map(Number);return `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;};
 const days=schedule.scheduleDays.join(',')==='1,2,3,4,5'?'Monday–Friday':schedule.scheduleDays.map(day=>['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][day-1]).join(', ');
 return `${days} · ${time(schedule.startTime)} – ${time(schedule.endTime)}`;
}
