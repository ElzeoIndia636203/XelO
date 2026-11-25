import { Card, Chip, Elzeo, PageHead, Wordmark } from '../../../components/ui';
import { useSession } from '../../../lib/session';

function PortalShell({
  kicker,
  title,
  lead,
  extra,
}: {
  kicker: string;
  title: string;
  lead: string;
  extra?: React.ReactNode;
}) {
  const { profile, institution, signOut } = useSession();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)' }}>
      <header
        className="dark-surface"
        style={{
          background: 'var(--rail)',
          color: '#FFFFFF',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Wordmark dark />
          <Elzeo dark />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span className="mono" style={{ color: '#CFCDC5' }}>
            {profile?.email}
          </span>
          <button
            type="button"
            className="btn"
            style={{ background: '#2C2B28', color: '#FFFFFF', borderColor: '#3E3D39' }}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </header>
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 20px' }}>
        <PageHead kicker={kicker} title={title} lead={lead} actions={extra} />
        <Card
          title="Active account"
          actions={<Chip tone="good">{profile?.role.replace('_', ' ')}</Chip>}
        >
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            Signed in as <strong>{profile?.full_name}</strong> ({profile?.email})
            {institution ? ` · ${institution.name}` : ''}.
          </p>
        </Card>
      </main>
    </div>
  );
}

export function StudentPortalPlaceholder() {
  return (
    <PortalShell
      kicker="STUDENT APP"
      title="Student home"
      lead="Enrolled courses, today's lab IDE, and lab files are delivered in Phase 4–5."
    />
  );
}

const OVERSIGHT_LABELS: Record<string, string> = {
  vc: 'VC',
  coe: 'CoE',
  dean: 'Dean',
};

export function OversightPortalPlaceholder() {
  const { profile } = useSession();
  const roleLabel = OVERSIGHT_LABELS[profile?.role ?? ''] ?? 'Oversight';
  return (
    <PortalShell
      kicker={`${roleLabel.toUpperCase()} CONSOLE`}
      title={`${roleLabel} monitor`}
      lead="School and university monitoring, internals review, and eligibility settings are delivered in Phase 6."
    />
  );
}
