import type { Metadata } from 'next';
import { AdminLogin } from '@/components/admin-login';
export const metadata: Metadata = { title: 'Administrator sign in · WaterCycle' };
export default function AdministratorLoginPage() { return <AdminLogin />; }
