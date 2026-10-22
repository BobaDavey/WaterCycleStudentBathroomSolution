import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { cookieName, sessionUser } from '@/lib/auth';
import { getDatabase } from '@/lib/db';
import { AdminDashboard } from '@/components/admin-dashboard';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Administrator Portal · WaterCycle' };
export default async function AdministratorDashboardPage() {
  const store = await cookies();
  const user = await sessionUser(await getDatabase(), store.get(cookieName)?.value);
  if (!user || user.role !== 'admin' || user.username !== 'davidanzezhang') redirect('/admin/login');
  return <AdminDashboard user={user} />;
}
