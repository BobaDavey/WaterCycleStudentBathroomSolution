export const DEFAULT_TIME_ZONE = 'America/New_York';
export const US_TIME_ZONES = [
 {label:'USA / Eastern (Default)',value:DEFAULT_TIME_ZONE},
 {label:'USA / Central',value:'America/Chicago'},
 {label:'USA / Mountain',value:'America/Denver'},
 {label:'USA / Pacific',value:'America/Los_Angeles'},
 {label:'USA / Alaska',value:'America/Anchorage'},
 {label:'USA / Hawaii',value:'Pacific/Honolulu'},
 {label:'USA / Arizona Mountain',value:'America/Phoenix'},
] as const;
const knownZones = new Map<string,string>(US_TIME_ZONES.map(zone=>[zone.value,zone.value]));
const formats = new Map<string,Intl.DateTimeFormat>();

/** Preserve valid existing IANA preferences, including ones outside the menu. */
export function effectiveTimeZone(value?: string | null): string {
 if(value?.trim()){
  if(knownZones.has(value))return knownZones.get(value)!;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value});knownZones.set(value,value);return value;}catch{}
 }
 return DEFAULT_TIME_ZONE;
}
function dateFormatter(zone: string | null | undefined, options: Intl.DateTimeFormatOptions, locale?: string) {
 const timeZone=effectiveTimeZone(zone),key=JSON.stringify([locale,timeZone,options]);
 let formatter=formats.get(key);
 if(!formatter){
  formatter=new Intl.DateTimeFormat(locale,{...options,timeZone});
  if(formats.size>=128)formats.delete(formats.keys().next().value!);
  formats.set(key,formatter);
 }
 return formatter;
}

export function formatClassTimestamp(value: string | number | Date | null, zone?: string | null, options: Intl.DateTimeFormatOptions = {dateStyle:'medium',timeStyle:'short'}, locale?: string): string {
 if(value===null)return '—';
 return dateFormatter(zone,options,locale).format(new Date(value));
}
export function formatClassDate(value: string | number | Date, zone?: string | null, options: Intl.DateTimeFormatOptions = {year:'numeric',month:'short',day:'numeric'}): string {
 return formatClassTimestamp(value,zone,options);
}
/** Date-input keys follow the class's calendar, independent of the browser. */
export function classDateKey(value: string | number | Date, zone?: string | null): string {
 const parts=dateFormatter(zone,{year:'numeric',month:'2-digit',day:'2-digit'},'en-US').formatToParts(new Date(value));
 const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)!.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
