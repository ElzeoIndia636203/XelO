import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTimeIst } from '../lib/format';
import { useSession } from '../lib/session';
import { fetchAll, supabase } from '../lib/supabase';
import type { NotificationRow } from '../lib/types';

function normalizeAppRoute(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed === '/app') return '/';
  if (trimmed.startsWith('/app/')) return trimmed.slice(4);
  return trimmed;
}

export function NotificationBell({ variant = 'light' }: { variant?: 'dark' | 'light' }) {
  const { profile } = useSession();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const profileId = profile?.id;

  const pullNotifications = async (uid: string) =>
    fetchAll<NotificationRow>((from, to) =>
      supabase
        .from('notifications')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .range(from, to),
    ).catch(() => [] as NotificationRow[]);

  useEffect(() => {
    if (!profileId) return;
    let alive = true;
    void fetchAll<NotificationRow>((from, to) =>
      supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .range(from, to),
    )
      .then((rows) => {
        if (alive) setNotifications(rows);
      })
      .catch(() => {});

    const channel = supabase
      .channel(`bell-notif-${profileId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${profileId}` },
        () => {
          void pullNotifications(profileId).then((rows) => {
            if (alive) setNotifications(rows);
          });
        },
      )
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [profileId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  async function markAllRead() {
    if (!profileId) return;
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', profileId)
      .is('read_at', null);
    const rows = await pullNotifications(profileId);
    setNotifications(rows);
  }

  async function openNotification(n: NotificationRow) {
    if (profileId && !n.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', n.id);
      setNotifications((prev) =>
        prev.map((row) =>
          row.id === n.id ? { ...row, read_at: new Date().toISOString() } : row,
        ),
      );
    }
    setOpen(false);
    const dest = normalizeAppRoute(n.link);
    if (dest) {
      void navigate(dest);
    }
  }

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <div ref={wrapRef} className="bell-wrap" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="btn field-sm"
        aria-expanded={open}
        aria-label={`Notifications (${unreadCount} unread)`}
        onClick={() => setOpen((prev) => !prev)}
        style={
          variant === 'dark'
            ? { background: '#2C2B28', color: '#FFFFFF', borderColor: '#3E3D39' }
            : undefined
        }
      >
        Bell ({unreadCount})
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="bell-popover"
          style={{
            position: 'absolute',
            right: 0,
            top: 40,
            width: 320,
            maxHeight: 400,
            overflowY: 'auto',
            background: '#FFFFFF',
            color: '#141413',
            border: '1px solid #D6D3C9',
            borderRadius: 6,
            padding: 12,
            zIndex: 60,
            boxShadow: '0 10px 30px rgba(20, 20, 19, 0.14)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13, color: '#141413' }}>Notifications</strong>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={unreadCount === 0}
              style={{
                minHeight: 28,
                padding: '0 10px',
                borderRadius: 4,
                border: '1px solid #D6D3C9',
                background: '#FBFAF7',
                color: unreadCount === 0 ? '#8F8D85' : '#141413',
                fontSize: 12,
                cursor: unreadCount === 0 ? 'default' : 'pointer',
              }}
            >
              Mark all read
            </button>
          </div>

          {notifications.length === 0 ? (
            <div style={{ fontSize: 12, color: '#6B6A63', padding: '8px 0' }}>No notifications yet.</div>
          ) : (
            notifications.slice(0, 8).map((n) => {
              const hasDest = Boolean(normalizeAppRoute(n.link));
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void openNotification(n)}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    padding: 8,
                    borderRadius: 5,
                    border: '1px solid #EFEDE6',
                    background: n.read_at ? '#FFFFFF' : '#FFF4EC',
                    color: '#141413',
                    fontSize: 12,
                    cursor: hasDest ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ fontWeight: 600, color: '#141413' }}>{n.title}</div>
                  {n.body ? <div style={{ marginTop: 2, color: '#3D3C38' }}>{n.body}</div> : null}
                  <div className="mono" style={{ marginTop: 4, fontSize: 10, color: '#6B6A63' }}>
                    {formatTimeIst(n.created_at)}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
