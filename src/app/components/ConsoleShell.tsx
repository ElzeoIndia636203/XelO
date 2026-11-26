import { useState, type ReactNode } from 'react';
import { NotificationBell } from '../../components/NotificationBell';
import { Elzeo, Wordmark } from '../../components/ui';

export interface NavItem {
  id: string;
  label: string;
  badge?: number;
}

export function ConsoleShell({
  roleTitle,
  scopeText,
  navItems,
  activeTab,
  onTabChange,
  userEmail,
  onSignOut,
  railFooterExtra,
  topbarExtra,
  children,
}: {
  roleTitle: string;
  scopeText: string;
  navItems: readonly NavItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  userEmail: string;
  onSignOut: () => void;
  railFooterExtra?: ReactNode;
  topbarExtra?: ReactNode;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="console-wrap">
      <aside
        className="console-rail dark-surface no-print"
        aria-label={`${roleTitle} navigation`}
        data-mobile-open={mobileOpen ? 'true' : 'false'}
      >
        <div style={{ padding: '0 6px' }}>
          <div style={{ fontSize: 20, lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                if (navItems[0]) onTabChange(navItems[0].id);
                setMobileOpen(false);
              }}
              aria-label={`XeIO ${roleTitle} home`}
              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
            >
              <Wordmark dark />
            </button>
            <span style={{ fontSize: 14, color: '#CFCDC5' }}>{roleTitle}</span>
          </div>
          <div style={{ fontSize: 11, color: '#A8A69E', marginTop: 4 }}>{scopeText}</div>
        </div>

        <nav className="console-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="console-nav-btn"
              aria-current={item.id === activeTab ? 'page' : undefined}
              onClick={() => {
                onTabChange(item.id);
                setMobileOpen(false);
              }}
            >
              <span>{item.label}</span>
              {item.badge && item.badge > 0 ? (
                <span className="console-nav-badge">{item.badge}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div
          className="console-rail-footer"
          style={{
            marginTop: 'auto',
            padding: '12px 8px 0',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {railFooterExtra}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8F8D85' }}>
            <span>by</span>
            <Elzeo dark />
          </div>
        </div>
      </aside>

      <div className="console-body">
        <header className="console-topbar no-print">
          <button
            type="button"
            className="btn field-sm console-mobile-menu-btn"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((o) => !o)}
          >
            {mobileOpen ? 'Close menu' : 'Menu'}
          </button>
          {topbarExtra}
          <NotificationBell variant="light" />
          <span className="mono" style={{ color: 'var(--muted)' }}>
            {userEmail}
          </span>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </header>
        <main className="console-main">{children}</main>
      </div>
    </div>
  );
}
