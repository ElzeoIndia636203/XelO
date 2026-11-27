import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Elzeo, Loading, Wordmark } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { isDomainAllowed } from '../../lib/logic/domain';
import { resolvePostLoginRoute } from '../../lib/logic/routing';
import { useSession } from '../../lib/session';
import { rpc, supabase } from '../../lib/supabase';

const POST_LOGIN_FROM_KEY = 'xeio_post_login_from';

export function LoginPage() {
  const { session, profile, restored, authError, setAuthError, reloadSession } = useSession();
  const location = useLocation();
  const stateFrom = (location.state as { from?: string } | null)?.from ?? null;

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<null | 'google' | 'azure' | 'otp' | 'verify'>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [otpSentEmail, setOtpSentEmail] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');

  if (!restored) {
    return (
      <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Restoring session…" />
      </main>
    );
  }

  if (session && profile) {
    const savedFrom = window.sessionStorage.getItem(POST_LOGIN_FROM_KEY);
    if (savedFrom) {
      window.sessionStorage.removeItem(POST_LOGIN_FROM_KEY);
    }
    const target = resolvePostLoginRoute(profile.role, stateFrom ?? savedFrom);
    return <Navigate to={target} replace />;
  }

  const activeError = localError ?? authError;

  async function validateAndPreflight(): Promise<string | null> {
    setLocalError(null);
    setAuthError(null);
    setStatusMsg(null);

    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes('@')) {
      setLocalError('Enter your email address.');
      return null;
    }

    try {
      const preflight = await rpc<string>('preflight_sign_in', { p_email: clean });
      if (preflight !== 'ok') {
        if (preflight === 'domain_mismatch' && !isDomainAllowed(clean, import.meta.env.VITE_ALLOWED_DOMAINS)) {
          setLocalError(errorMessage('domain_mismatch'));
        } else {
          setLocalError(errorMessage(preflight));
        }
        return null;
      }
      return clean;
    } catch (err) {
      setLocalError(errorMessage(err));
      return null;
    }
  }

  async function handleOAuth(provider: 'google' | 'azure') {
    setBusy(provider);
    try {
      const validEmail = await validateAndPreflight();
      if (!validEmail) return;

      if (stateFrom) {
        window.sessionStorage.setItem(POST_LOGIN_FROM_KEY, stateFrom);
      }

      const redirectTo = `${window.location.origin}/app/login`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          queryParams: { login_hint: validEmail },
        },
      });
      if (error) {
        setLocalError(errorMessage(error.message));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleOtp(e: FormEvent) {
    e.preventDefault();
    setBusy('otp');
    try {
      const validEmail = await validateAndPreflight();
      if (!validEmail) return;

      if (stateFrom) {
        window.sessionStorage.setItem(POST_LOGIN_FROM_KEY, stateFrom);
      }

      const { error } = await supabase.auth.signInWithOtp({
        email: validEmail,
        options: {
          // Server-side signup is gated by preflight_sign_in + the auth.users BEFORE INSERT trigger
          // against public.invites; first-time invited users need shouldCreateUser: true so GoTrue
          // can issue the OTP link before their auth.users row exists.
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}/app/login`,
        },
      });
      if (error) {
        setLocalError(errorMessage(error.message));
      } else {
        setOtpSentEmail(validEmail);
        setOtpCode('');
        setStatusMsg(`Sign-in link and code sent to ${validEmail}. Check your inbox.`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    if (!otpSentEmail || !otpCode.trim()) return;
    setBusy('verify');
    setLocalError(null);
    setAuthError(null);
    try {
      let { error } = await supabase.auth.verifyOtp({
        email: otpSentEmail,
        token: otpCode.trim(),
        type: 'email',
      });
      if (error) {
        const retry = await supabase.auth.verifyOtp({
          email: otpSentEmail,
          token: otpCode.trim(),
          type: 'signup',
        });
        error = retry.error;
      }
      if (error) {
        setLocalError(errorMessage(error.message));
      } else {
        await reloadSession();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexWrap: 'wrap',
        background: 'var(--paper)',
        color: 'var(--ink)',
      }}
    >
      <section
        className="dark-surface"
        aria-label="About XeIO"
        style={{
          flex: '1 1 420px',
          background: 'var(--rail)',
          color: '#E8E6DF',
          padding: '56px 48px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div style={{ fontSize: 44, lineHeight: 1 }}>
          <Wordmark dark />
        </div>
        <h1
          style={{
            marginTop: 48,
            fontSize: 36,
            fontWeight: 600,
            lineHeight: 1.15,
            maxWidth: 440,
            color: '#FFFFFF',
          }}
        >
          The AI faculty assistant that plans, runs and reports every lab.
        </h1>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.6,
            color: '#CFCDC5',
            maxWidth: 440,
          }}
        >
          One sign-in for faculty, students, HODs, deans, the CoE and the VC. Each role sees only its own scope.
        </p>
        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 32,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: '#A8A69E',
            }}
          >
            Designed and maintained by
          </div>
          <div style={{ width: 200 }}>
            <Elzeo dark />
          </div>
          <div style={{ fontSize: 12, color: '#A8A69E' }}>
            Elzeo Future Technologies Pvt Ltd, India · For AI Enabled HEIs
          </div>
        </div>
      </section>

      <main
        style={{
          flex: '1 1 420px',
          padding: '56px 48px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 18,
          maxWidth: 560,
        }}
      >
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 600 }}>Sign in</h2>
          <p style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5, color: 'var(--muted)' }}>
            Use your institutional account. Only emails created by the super admin, or invited by your faculty with a
            class code, can sign in.
          </p>
        </div>

        <form onSubmit={handleOtp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="email" style={{ fontSize: 13, fontWeight: 600 }}>
              Institutional email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setLocalError(null);
                setStatusMsg(null);
              }}
              placeholder="name@sanjivani.edu.in"
              style={{
                height: 46,
                padding: '0 12px',
                border: '1px solid #D6D3C9',
                borderRadius: 6,
                fontSize: 15,
                background: '#FFFFFF',
                color: 'var(--ink)',
              }}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void handleOAuth('google')}
            style={{ height: 46, fontSize: 15, fontWeight: 600 }}
          >
            {busy === 'google' ? 'Redirecting…' : 'Continue with Google'}
          </button>

          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void handleOAuth('azure')}
            style={{ height: 44, fontSize: 14, fontWeight: 600 }}
          >
            {busy === 'azure' ? 'Redirecting…' : 'Continue with Microsoft'}
          </button>

          <button
            type="submit"
            className="btn btn-ghost"
            disabled={busy !== null}
            style={{
              height: 40,
              fontSize: 13,
              border: '1px solid var(--border)',
              background: 'var(--surface-alt)',
            }}
          >
            {busy === 'otp' ? 'Sending link…' : 'Email me a sign-in link'}
          </button>
        </form>

        {statusMsg ? (
          <div className="banner banner-ok" role="status">
            {statusMsg}
          </div>
        ) : null}

        {otpSentEmail ? (
          <form onSubmit={handleVerifyOtp} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="field mono"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="Verification code from email"
              style={{ flex: 1, height: 40 }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy !== null || otpCode.trim().length < 6}
              style={{ height: 40 }}
            >
              {busy === 'verify' ? 'Verifying…' : 'Verify code'}
            </button>
          </form>
        ) : null}

        {activeError ? (
          <div className="banner banner-err" role="alert">
            {activeError}
          </div>
        ) : null}

        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          <a href="/" style={{ color: 'var(--teal)', fontWeight: 500 }}>
            ← Back to XeIO overview
          </a>
        </div>
      </main>
    </div>
  );
}
