"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { AuthUser } from "./types";

const STORAGE_KEY = "ctodo.auth";

interface StoredAuth {
  token: string;
  user: AuthUser;
}

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  /** True until the initial localStorage read (and background /auth/me
   *  revalidation) has finished — avoids a login-page flash for a user who
   *  is actually already authenticated. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredAuth(): StoredAuth | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.token || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredAuth(value: StoredAuth | null) {
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode, quota, etc.) — auth still works
    // for this tab, it just won't survive a reload.
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect --
       One-time hydration from localStorage (an external, non-reactive
       source) on mount — this must run after mount (SSR has no
       `window.localStorage`), so it can't be a `useState` lazy initializer,
       and it isn't state "derived" from props/state the lint rule's
       rewrite otherwise applies to. */
    const stored = readStoredAuth();
    if (!stored) {
      setIsLoading(false);
      return;
    }
    setToken(stored.token);
    setUser(stored.user);
    setIsLoading(false);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Revalidate in the background: a token that expired or was revoked
    // while the tab was closed should log the user out on next load rather
    // than pretending they're still signed in until the first API call
    // fails deep inside some other flow.
    api.me(stored.token).catch(() => {
      setToken(null);
      setUser(null);
      writeStoredAuth(null);
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setToken(result.accessToken);
    setUser(result.user);
    writeStoredAuth({ token: result.accessToken, user: result.user });
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    writeStoredAuth(null);
  }, []);

  const value = useMemo(
    () => ({ token, user, isLoading, login, logout }),
    [token, user, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
