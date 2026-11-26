import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { errorMessage } from './errors';
import { supabase } from './supabase';
import type { Institution, Profile } from './types';

interface SessionContextValue {
  session: Session | null;
  profile: Profile | null;
  institution: Institution | null;
  restored: boolean;
  authError: string | null;
  setAuthError: (msg: string | null) => void;
  signOut: () => Promise<void>;
  reloadSession: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const STUDENT_MAX_MS = 12 * 60 * 60 * 1000;
const STAFF_IDLE_MS = 8 * 60 * 60 * 1000;
const LOGIN_AT_KEY = 'xeio_login_at';
const LAST_ACTIVE_KEY = 'xeio_last_active_at';
const SESSION_USER_KEY = 'xeio_session_user';
const TOUCH_THROTTLE_MS = 15_000;

function clearSharedSessionTimers() {
  try {
    window.localStorage.removeItem(LOGIN_AT_KEY);
    window.localStorage.removeItem(LAST_ACTIVE_KEY);
    window.localStorage.removeItem(SESSION_USER_KEY);
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [institution, setInstitution] = useState<Institution | null>(null);
  const [restored, setRestored] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const loadForSession = useCallback(async (nextSession: Session | null) => {
    const seq = ++loadSeqRef.current;

    if (!nextSession) {
      clearSharedSessionTimers();
      if (seq === loadSeqRef.current) {
        setSession(null);
        setProfile(null);
        setInstitution(null);
        setRestored(true);
      }
      return;
    }

    try {
      const { data: prof, error: profErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', nextSession.user.id)
        .maybeSingle<Profile>();

      if (seq !== loadSeqRef.current) return;

      if (profErr || !prof) {
        setAuthError(errorMessage('not_onboarded'));
        await supabase.auth.signOut();
        if (seq === loadSeqRef.current) {
          setSession(null);
          setProfile(null);
          setInstitution(null);
          setRestored(true);
        }
        return;
      }

      if (!prof.active) {
        setAuthError(errorMessage('deactivated'));
        await supabase.auth.signOut();
        if (seq === loadSeqRef.current) {
          setSession(null);
          setProfile(null);
          setInstitution(null);
          setRestored(true);
        }
        return;
      }

      const now = Date.now();
      const storedUser = window.localStorage.getItem(SESSION_USER_KEY);
      const isSameUser = storedUser === nextSession.user.id;
      const loginAtRaw = isSameUser ? window.localStorage.getItem(LOGIN_AT_KEY) : null;
      const lastActiveRaw = isSameUser ? window.localStorage.getItem(LAST_ACTIVE_KEY) : null;
      const loginAt = loginAtRaw ? Number(loginAtRaw) : now;
      const lastActive = lastActiveRaw ? Number(lastActiveRaw) : now;

      if (!isSameUser || !loginAtRaw) {
        window.localStorage.setItem(SESSION_USER_KEY, nextSession.user.id);
        window.localStorage.setItem(LOGIN_AT_KEY, String(now));
      }
      window.localStorage.setItem(LAST_ACTIVE_KEY, String(isSameUser ? Math.max(lastActive, now) : now));

      const expired =
        prof.role === 'student'
          ? now - loginAt > STUDENT_MAX_MS
          : now - lastActive > STAFF_IDLE_MS;

      if (expired) {
        clearSharedSessionTimers();
        await supabase.auth.signOut();
        if (seq === loadSeqRef.current) {
          setSession(null);
          setProfile(null);
          setInstitution(null);
          setRestored(true);
        }
        return;
      }

      let inst: Institution | null = null;
      if (prof.institution_id) {
        const { data: instRow } = await supabase
          .from('institutions')
          .select('*')
          .eq('id', prof.institution_id)
          .maybeSingle<Institution>();
        inst = instRow ?? null;
      }

      if (seq === loadSeqRef.current) {
        setSession(nextSession);
        setProfile(prof);
        setInstitution(inst);
        setRestored(true);
      }
    } catch {
      if (seq === loadSeqRef.current) {
        setSession(null);
        setProfile(null);
        setInstitution(null);
        setRestored(true);
      }
    }
  }, []);

  const reloadSession = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await loadForSession(data.session ?? null);
  }, [loadForSession]);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        void loadForSession(data.session ?? null);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) {
        void loadForSession(nextSession);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadForSession]);

  useEffect(() => {
    if (!profile) return;
    let lastWrite = 0;
    const touch = () => {
      const now = Date.now();
      if (now - lastWrite < TOUCH_THROTTLE_MS) return;
      lastWrite = now;
      window.localStorage.setItem(LAST_ACTIVE_KEY, String(now));
    };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
    };
  }, [profile]);

  const signOut = useCallback(async () => {
    clearSharedSessionTimers();
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setInstitution(null);
    setAuthError(null);
  }, []);

  return (
    <SessionContext.Provider
      value={{
        session,
        profile,
        institution,
        restored,
        authError,
        setAuthError,
        signOut,
        reloadSession,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside SessionProvider');
  }
  return ctx;
}
