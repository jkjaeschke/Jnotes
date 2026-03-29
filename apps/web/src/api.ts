const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const API_BASE = RAW_BASE.replace(/\/$/, "");

/**
 * Build the request URL for the API.
 * - **Dev:** leave `VITE_API_BASE_URL` unset so requests stay same-origin (`/api/...`) and hit the Vite proxy.
 * - **Prod:** set `VITE_API_BASE_URL` to your Cloud Run (or API) origin, e.g. `https://freenotes-api-xxxxx-uc.a.run.app`
 */
export function apiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) return p;
  return `${API_BASE}${p}`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

async function parseJsonOk<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const snippet = (await res.text()).slice(0, 120);
    throw new Error(
      snippet ? `Expected JSON from API, got: ${snippet}…` : "Expected JSON from API"
    );
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string, googleToken?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (googleToken) {
    headers.Authorization = `Bearer ${googleToken}`;
  }
  const res = await fetch(apiUrl(path), { credentials: "include", headers });
  if (!res.ok) throw new Error(await parseError(res));
  return parseJsonOk<T>(res);
}

/** Same as apiGet but returns null on 401 (no session) instead of throwing — avoids noisy errors on the login page. */
export async function apiGetOptional<T>(path: string, googleToken?: string | null): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (googleToken) {
    headers.Authorization = `Bearer ${googleToken}`;
  }
  const res = await fetch(apiUrl(path), { credentials: "include", headers });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(await parseError(res));
  return parseJsonOk<T>(res);
}

export async function apiSend<T>(
  path: string,
  method: string,
  body?: unknown,
  googleToken?: string | null
): Promise<T> {
  const headers: Record<string, string> = {};
  if (googleToken) {
    headers.Authorization = `Bearer ${googleToken}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  if (res.status === 204) return undefined as T;
  return parseJsonOk<T>(res);
}

export async function apiUpload(
  path: string,
  form: FormData,
  googleToken?: string | null
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (googleToken) {
    headers.Authorization = `Bearer ${googleToken}`;
  }
  const res = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    headers,
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return parseJsonOk(res);
}
