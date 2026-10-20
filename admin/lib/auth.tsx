import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setCsrf } from "./api";
import type { Permission } from "../../shared/types";

export interface Me {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleName: string;
  permissions: Permission[];
}

interface AuthCtx {
  user: Me | null;
  ready: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: Me | null; csrf?: string }>("/auth/me");
      setUser(r.user);
      if (r.csrf) setCsrf(r.csrf);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    refresh();
    const h = () => setUser(null);
    window.addEventListener("reef:signed-out", h);
    return () => window.removeEventListener("reef:signed-out", h);
  }, [refresh]);
  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    setUser(null);
  };
  return <Ctx.Provider value={{ user, ready, refresh, logout, can: (p) => !!user?.permissions.includes(p) }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

// Lightweight cross-view event bus (e.g. "content types changed" → refresh sidebar)
export const bus = {
  emit: (name: string) => window.dispatchEvent(new CustomEvent(`reef:${name}`)),
  on: (name: string, fn: () => void) => {
    window.addEventListener(`reef:${name}`, fn);
    return () => window.removeEventListener(`reef:${name}`, fn);
  },
};
