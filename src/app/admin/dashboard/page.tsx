import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { cookieName, sessionUser } from '@/lib/auth';
import { allowedAdministrator } from '@/lib/bootstrap-admin';
import { getDatabase } from '@/lib/db';
import { AdminDashboard } from '@/components/admin-dashboard';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Administrator Portal · WaterCycle' };
export default async function AdministratorDashboardPage() {
  const store = await cookies();
  const db = await getDatabase();
  const user = await sessionUser(db, store.get(cookieName)?.value);
  if (!user || user.role !== 'admin' || !allowedAdministrator(db,user.username)) redirect('/admin/login');
  return <AdminDashboard user={user} />;
}
