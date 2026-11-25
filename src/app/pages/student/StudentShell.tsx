import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { NotificationBell } from '../../../components/NotificationBell';
import { Elzeo, Wordmark } from '../../../components/ui';
import { useSession } from '../../../lib/session';

export type StudentTabId = 'home' | 'classroom' | 'lab' | 'file' | 'endsem';

export function StudentShell({
  activeTab,
  hasTodayLab = false,
  hasScheduledExam = false,
  todaySessionId,
  children,
}: {
  activeTab: StudentTabId;
  hasTodayLab?: boolean;
  hasScheduledExam?: boolean;
  todaySessionId?: string | null;
  children: ReactNode;
}) {
  const { profile, signOut } = useSession();

  const navItems: Array<{ id: StudentTabId; label: string; to: string; visible: boolean }> = [
    { id: 'home', label: 'Home', to: '/student', visible: true },
    { id: 'classroom', label: 'Classroom', to: '/student/classroom', visible: true },
    {
      id: 'lab',
      label: "Today's lab",
      to: todaySessionId ? `/student/lab/${todaySessionId}` : '/student/lab',
      visible: hasTodayLab || activeTab === 'lab',
    },
    { id: 'file', label: 'Lab file', to: '/student/lab-file', visible: true },
    { id: 'endsem', label: 'End-sem', to: '/student/endsem', visible: hasScheduledExam || activeTab === 'endsem' },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
      <header
        className="dark-surface no-print"
        style={{
          minHeight: 54,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 20px',
          background: 'var(--rail)',
          color: '#E8E6DF',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/student" style={{ textDecoration: 'none' }}>
            <Wordmark dark />
          </Link>
          <Elzeo dark />
        </div>

        <nav aria-label="Student navigation" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {navItems
            .filter((item) => item.visible)
            .map((item) => {
              const active = item.id === activeTab;
              return (
                <Link
                  key={item.id}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    minHeight: 34,
                    padding: '0 12px',
                    borderRadius: 5,
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: 13,
                    textDecoration: 'none',
                    background: active ? '#2C2B28' : 'transparent',
                    color: active ? '#FFFFFF' : '#CFCDC5',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
          <NotificationBell variant="dark" />
          <span className="mono" style={{ color: '#CFCDC5' }}>
            {profile?.full_name} · {profile?.roll_no ?? profile?.email}
          </span>
          <button
            type="button"
            className="btn field-sm"
            onClick={() => void signOut()}
            style={{ background: '#2C2B28', color: '#FFFFFF', borderColor: '#3E3D39' }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: 1240, margin: '0 auto', padding: '24px 20px' }}>
        {children}
      </main>

      <footer
        className="no-print"
        style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 20px',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        <Wordmark />
        <span>· designed and maintained by</span>
        <Elzeo />
        <span>Elzeo Future Technologies Pvt Ltd, India</span>
      </footer>
    </div>
  );
}
