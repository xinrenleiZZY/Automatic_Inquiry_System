import axios from 'axios';

export const api = axios.create({
  baseURL: '',
  timeout: 180000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});

export function detailOf(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown }; status?: number }; message?: string };
  const d = e?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d
      .map((x: { loc?: unknown[]; msg?: string }) => `${(x.loc || []).slice(1).join('.')} ${x.msg}`)
      .join('；');
  }
  if (e?.response?.status) return `请求失败（HTTP ${e.response.status}）`;
  return e?.message || '未知错误';
}

api.interceptors.response.use(
  (r) => r,
  (error) => {
    const status = error?.response?.status;
    const url: string = error?.config?.url || '';
    // 401 拦截：避免对 /api/auth/* 自身拦截导致死循环；也避免在登录页反复跳
    if (status === 401 && !url.startsWith('/api/auth/') && !location.pathname.startsWith('/login')) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.href = `/login?redirect=${back}`;
    }
    return Promise.reject(error);
  }
);

export const get = async <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
  (await api.get<T>(url, { params })).data;

export const post = async <T>(url: string, body?: unknown): Promise<T> =>
  (await api.post<T>(url, body)).data;

export const put = async <T>(url: string, body?: unknown): Promise<T> =>
  (await api.put<T>(url, body)).data;

export const del = async <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
  (await api.delete<T>(url, { params })).data;
