export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body as T;
}
export function post<T>(path: string, body?: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}
export function time(value: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
}
export function duration(start: string | null, end?: string | null) {
  if (!start) return "—";
  const minutes = Math.max(0, Math.floor(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 60000));
  return minutes < 1 ? "< 1 min" : `${minutes} min`;
}
