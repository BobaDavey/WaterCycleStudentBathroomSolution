import { test, expect } from './fixtures';
test('readiness is available without login and exposes no database or account details',async({request})=>{
 const health=await request.get('/api/health');expect(health.status()).toBe(200);expect(await health.json()).toEqual({ok:true});expect(health.headers()['set-cookie']).toBeUndefined();expect(health.headers()['cache-control']).toBe('no-store');
 const auth=await request.get('/api/auth/me');expect((await auth.json()).user).toBeNull();
});
