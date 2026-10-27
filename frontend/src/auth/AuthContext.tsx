import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post } from '../api/client';
import type { UserInfo } from '../api/types';

interface AuthState {
  user: UserInfo | null;
  loading: boolean;
  refresh: () => Promise<UserInfo | null>;
  logout: () => Promise<void>;
  isAdmin: boolean;
  canManage: boolean;
}

const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => null,
  logout: async () => undefined,
  isAdmin: false,
  canManage: false
});

/** 门户地址的兜底值；正常由 /api/auth/config 下发（后端配置项 PORTAL_LOGOUT_URL / SSO_LOGIN_URL） */
const PORTAL_LOGOUT_FALLBACK = 'http://192.168.40.194:6690/logout';
const PORTAL_LOGIN_FALLBACK = 'http://192.168.40.194:6690/login';

/** 跳到顶层窗口：本应用被门户用 iframe 内嵌（open_mode=embedded）时，
 *  只改 window.location 会把门户页面塞进那个小框里，必须让顶层跳。 */
function navigateTop(url: string): void {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch {
    /* 跨域受限就退回当前窗口 */
  }
  window.location.href = url;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await get<UserInfo>('/api/auth/me');
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    /* 先清掉本应用自己的会话 */
    try {
      await post('/api/auth/logout');
    } catch {
      /* 本地清不掉也要继续，否则用户退不出去 */
    }
    setUser(null);

    /* 再退掉门户会话：只清本应用 cookie 的话，下次进任何接入的应用
       都会被门户静默登回来（等于没退）。 */
    let logoutUrl = PORTAL_LOGOUT_FALLBACK;
    let loginUrl = PORTAL_LOGIN_FALLBACK;
    try {
      const cfg = await get<{ portal_logout_url?: string; sso_login_url?: string }>('/api/auth/config');
      if (cfg?.portal_logout_url) logoutUrl = cfg.portal_logout_url;
      if (cfg?.sso_login_url) loginUrl = cfg.sso_login_url;
    } catch {
      /* 拿不到配置就用兜底地址 */
    }

    /* 关键：用隐藏 iframe 去"请求"门户登出页，而不是把浏览器导航过去。
       原因：门户目前还没有 /logout 页面，直接跳过去用户会看到 404；
       放在隐藏 iframe 里就看不见了。等门户补上这个页面，
       同一段代码会自动把门户会话也清掉，这边一行都不用改。 */
    try {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      frame.src = logoutUrl;
      document.body.appendChild(frame);
      await new Promise((resolve) => setTimeout(resolve, 1800)); // 等它把门户 cookie 清掉
      frame.remove();
    } catch {
      /* iframe 失败不影响后面的跳转 */
    }

    /* 最后让**顶层窗口**回到门户登录页（被内嵌时只跳 iframe 是没用的） */
    navigateTop(loginUrl);
  }, []);

  const value = useMemo<AuthState>(() => {
    const roles = user?.roles || [];
    return {
      user,
      loading,
      refresh,
      logout,
      isAdmin: roles.includes('admin'),
      canManage: roles.includes('admin') || roles.includes('gm')
    };
  }, [user, loading, refresh, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
