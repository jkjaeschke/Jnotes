async function parseError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function apiGet<T>(path: string, googleToken?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (googleToken) {
    headers.Authorization = `Bearer ${googleToken}`;
  }
  const res = await fetch(path, { credentials: "include", headers });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<T>;
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
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
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
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers,
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
