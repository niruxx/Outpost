const TOKEN_KEY = 'outpost_token';
// Sessions signed in before the rename to Outpost are carried over instead of being logged out.
const LEGACY_TOKEN_KEY = 'multicraft_token';

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy) {
    localStorage.setItem(TOKEN_KEY, legacy);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  return legacy;
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !(init.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`/api${path}`, { ...init, headers });

  if (res.status === 401) {
    setToken(null);
    if (!path.startsWith('/auth/')) {
      window.location.href = '/login';
    }
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = isJson && body && typeof body === 'object' && 'error' in body ? body.error : res.statusText;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

export interface UploadProgress {
  loaded: number; total: number | null; percent: number | null; elapsedSeconds: number;
  remainingSeconds: number | null; bytesPerSecond: number; processing: boolean;
}
function upload<T>(path: string, formData: FormData, onProgress?: (progress: UploadProgress) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    xhr.open('POST', `/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const report = (loaded: number, total: number | null, processing = false) => {
      const elapsedSeconds = (performance.now() - started) / 1000;
      const bytesPerSecond = loaded / Math.max(elapsedSeconds, 0.001);
      onProgress?.({ loaded, total, percent: total ? Math.min(100, loaded / total * 100) : null, elapsedSeconds,
        remainingSeconds: total && bytesPerSecond > 0 ? Math.max(0, (total - loaded) / bytesPerSecond) : null, bytesPerSecond, processing });
    };
    xhr.upload.onprogress = e => report(e.loaded, e.lengthComputable ? e.total : null);
    xhr.upload.onload = e => report(e.loaded, e.lengthComputable ? e.total : null, true);
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network connection lost'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    xhr.onload = () => {
      if (xhr.status === 401) { setToken(null); window.location.href = '/login'; }
      let body;
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined; } catch { body = xhr.responseText; }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(xhr.status, body?.error ?? xhr.statusText ?? 'Upload failed'));
      resolve(body as T);
    };
    report(0, null);
    xhr.send(formData);
  });
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body !== undefined ? JSON.stringify(body) : undefined }),
  upload,
};

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken() ?? '';
  return `${proto}://${window.location.host}${path}?token=${encodeURIComponent(token)}`;
}

export function downloadUrl(path: string): string {
  const token = getToken() ?? '';
  return `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
