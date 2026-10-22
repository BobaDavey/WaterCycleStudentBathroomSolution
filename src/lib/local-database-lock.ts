import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
interface Owner { pid: number; token: string; boot: string | null; start: string | null; }
async function readText(file: string) { try { return await readFile(file,'utf8'); } catch { return null; } }
async function fingerprint(pid: number) {
 const stat = await readText(`/proc/${pid}/stat`);
 return stat ? stat.slice(stat.lastIndexOf(')')+2).split(' ')[19] : null;
}
async function alive(owner: Owner) {
 try { process.kill(owner.pid,0); } catch(error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
 const boot = (await readText('/proc/sys/kernel/random/boot_id'))?.trim() ?? null;
 if (boot && owner.boot && boot !== owner.boot) return false;
 const start = await fingerprint(owner.pid);
 return !start || !owner.start || start === owner.start;
}
/** Local PGlite is single-process. PostgreSQL production connections do not use this lock. */
export async function lockLocalDatabase(directory: string): Promise<() => Promise<void>> {
 const file = `${path.resolve(directory)}.watercycle.lock`;
 await mkdir(path.dirname(file),{recursive:true});
 const owner: Owner = {pid:process.pid,token:randomUUID(),boot:(await readText('/proc/sys/kernel/random/boot_id'))?.trim() ?? null,start:await fingerprint(process.pid)};
 for (let attempt=0;attempt<4;attempt++) {
  try {
   const handle=await open(file,'wx',0o600);
   try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
   return async () => {
    const contents=await readText(file);
    if (contents && (JSON.parse(contents) as Owner).token === owner.token) await unlink(file).catch(()=>{});
   };
  } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
   const contents=await readText(file);
   if (!contents) throw new Error('The local database is being opened by another process. Stop the other server before retrying.');
   let previous: Owner;
   try { previous=JSON.parse(contents) as Owner; } catch { throw new Error('The local database lock is invalid. Confirm no server is running before removing its .watercycle.lock file.'); }
   if (!Number.isInteger(previous.pid) || previous.pid<1 || !previous.token) throw new Error('The local database lock is invalid. Confirm no server is running before removing its .watercycle.lock file.');
   if (await alive(previous)) throw new Error('This local database is already open in another process. Stop the other server or use a different LOCAL_DATABASE_PATH.');
   // Recheck ownership before reclaiming a lock left by a dead process or a restored snapshot.
   if (await readText(file) === contents) await unlink(file).catch(()=>{});
  }
 }
 throw new Error('The local database is busy. Stop other local instances and retry.');
}
