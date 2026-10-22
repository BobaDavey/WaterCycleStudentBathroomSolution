/**
 * Next may normalize a request URL to the server's bind address (0.0.0.0).
 * The routed Host header retains the authority the browser actually addressed.
 * Never substitute an untrusted forwarded-host header for it.
 */
export function isSameOrigin(origin: string | null, host: string | null, httpsOnly = false): boolean {
 if (!origin || !host || /[\s/\\@?#,]/.test(host)) return false;
 try {
  const source = new URL(origin);
  if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false;
  if (httpsOnly && source.protocol !== 'https:') return false;
  const destination = new URL(`${source.protocol}//${host}`);
  return destination.origin === source.origin;
 } catch { return false; }
}

export function usesSecureCookie(origin: string | null, requestProtocol: string, vercel = false): boolean {
 if (vercel || requestProtocol === 'https:') return true;
 try { return origin !== null && new URL(origin).protocol === 'https:'; }
 catch { return false; }
}
