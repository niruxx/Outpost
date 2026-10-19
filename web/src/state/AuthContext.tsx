import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from '../api/client.js';
import { applyAssignedTheme } from '../lib/theme.js';
import type { EffectiveCreation, PublicUser, Role } from '../api/types.js';

/** What a role can create when the server's creation policy hasn't loaded (yet) — so the
 *  "New instance" button never silently disappears. The server still enforces the real policy. */
function roleFallbackCreation(role: Role): EffectiveCreation {
  if (role === 'admin') {
    return { canCreate: true, platforms: ['java', 'bedrock', 'steam'], maxInstances: 0, maxMemoryMb: 0, containers: 'any', engineSocket: true, allowedPlatforms: ['java', 'bedrock', 'steam', 'custom', 'docker'], owned: 0, fromRole: true };
  }
  if (role === 'moderator') {
    return { canCreate: true, platforms: ['java', 'bedrock', 'steam'], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false, allowedPlatforms: ['java', 'bedrock', 'steam'], owned: 0, fromRole: true };
  }
  return { canCreate: false, platforms: [], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false, allowedPlatforms: [], owned: 0, fromRole: true };
}

interface AuthState {
  user: PublicUser | null;
  /** What this account may create (and how many it already owns). */
  creation: EffectiveCreation | null;
  /** Re-reads the creation policy/owned count without the full-screen loading state. */
  refreshCreation: () => Promise<void>;
  loading: boolean;
  setupRequired: boolean;
  /** Resolves 'two-factor' when the password was right and a code is needed (call again with it). */
  login: (username: string, password: string, code?: string) => Promise<'ok' | 'two-factor'>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [creation, setCreation] = useState<EffectiveCreation | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await api.get<{ setupRequired: boolean }>('/auth/status');
      setSetupRequired(status.setupRequired);
      if (!status.setupRequired && getToken()) {
        try {
          const res = await api.get<{ user: PublicUser; creation: EffectiveCreation }>('/auth/me');
          applyAssignedTheme(res.user.theme);
          setUser(res.user);
          setCreation(res.creation ?? null);
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshCreation = useCallback(async () => {
    if (!getToken()) return;
    try {
      const res = await api.get<{ creation: EffectiveCreation }>('/auth/me');
      setCreation(res.creation ?? null);
    } catch {
      // keep the last known policy
    }
  }, []);

  // Fetch the policy after login/setup too (those responses don't include it).
  useEffect(() => {
    if (user) refreshCreation();
    else setCreation(null);
  }, [user, refreshCreation]);

  // If it couldn't be loaded (server restarting/unreachable), keep retrying in the background.
  useEffect(() => {
    if (!user || creation) return;
    const t = setInterval(refreshCreation, 10_000);
    return () => clearInterval(t);
  }, [user, creation, refreshCreation]);

  const effectiveCreation = creation ?? (user ? roleFallbackCreation(user.role) : null);

  const login = useCallback(async (username: string, password: string, code?: string) => {
    const res = await api.post<{ token?: string; user?: PublicUser; twoFactorRequired?: boolean }>('/auth/login', {
      username,
      password,
      ...(code ? { code } : {}),
    });
    if (res.twoFactorRequired || !res.token || !res.user) return 'two-factor' as const;
    setToken(res.token);
    // An admin can give an account a theme; it applies once per assignment (the user can switch after).
    applyAssignedTheme(res.user.theme);
    setUser(res.user);
    return 'ok' as const;
  }, []);

  const setup = useCallback(async (username: string, password: string) => {
    const { token, user } = await api.post<{ token: string; user: PublicUser }>('/auth/setup', {
      username,
      password,
    });
    setToken(token);
    setUser(user);
    setSetupRequired(false);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, creation: effectiveCreation, refreshCreation, loading, setupRequired, login, setup, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
