import { useState } from 'react';
import { Card } from './ui';
import { errorMessage } from '../lib/errors';
import { useSession } from '../lib/session';
import { rpc } from '../lib/supabase';

function buildCalendarFeedUrl(token: string): string {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  const cleanBase = baseUrl.replace(/\/+$/, '');
  return `${cleanBase}/functions/v1/calendar?t=${encodeURIComponent(token)}`;
}

export function CalendarLinkCard() {
  const { profile, reloadSession } = useSession();
  const [overrideToken, setOverrideToken] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const token = overrideToken ?? profile?.calendar_token ?? '';
  const feedUrl = token ? buildCalendarFeedUrl(token) : '';

  async function handleCopy() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard?.writeText(feedUrl);
      setStatus({ text: 'Calendar link copied to clipboard.', ok: true });
    } catch {
      setStatus({ text: 'Copy the URL directly from the box above.', ok: false });
    }
  }

  async function handleReset() {
    setBusy(true);
    setStatus(null);
    try {
      const next = await rpc<string>('rotate_calendar_token');
      setOverrideToken(next);
      await reloadSession();
      setStatus({ text: 'Generated a fresh calendar link. Previous link is now revoked.', ok: true });
    } catch (err) {
      setStatus({ text: errorMessage(err), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Personal calendar feed"
      actions={<span style={{ fontSize: 12, color: 'var(--muted)' }}>ICS · IST</span>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Subscribe in Google Calendar or Outlook. Resetting revokes your previous link immediately.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            aria-label="Personal calendar feed URL"
            className="field field-sm mono"
            readOnly
            value={feedUrl}
            style={{ flex: '1 1 280px', minWidth: 0, background: 'var(--surface-alt)' }}
          />
          <button
            type="button"
            className="btn field-sm"
            disabled={!feedUrl}
            onClick={() => void handleCopy()}
          >
            Copy link
          </button>
          <button
            type="button"
            className="btn field-sm"
            disabled={busy}
            onClick={() => void handleReset()}
          >
            {busy ? 'Resetting…' : 'Reset link'}
          </button>
        </div>
        {status ? (
          <div role="status" style={{ fontSize: 12, color: status.ok ? 'var(--teal)' : 'var(--danger)' }}>
            {status.text}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
