import { Link } from 'react-router-dom';
import { effectiveRoles, homeForRole, type UserRole } from '../../lib/logic/routing';
import { useSession } from '../../lib/session';

const PORTAL_LABELS: Record<UserRole, string> = {
  super_admin: 'Super admin',
  vc: 'VC console',
  coe: 'CoE console',
  dean: 'Dean console',
  hod: 'HOD console',
  faculty: 'Faculty workspace',
  student: 'Student portal',
};

export function RolePortalToggle({
  active,
  dark = false,
}: {
  active: 'admin' | 'oversight' | 'hod' | 'faculty' | 'student';
  dark?: boolean;
}) {
  const { profile } = useSession();
  if (!profile) return null;

  const assigned = effectiveRoles(profile.role, profile.roles);
  const portals: Array<{ key: string; to: string; label: string }> = [];
  const seenRoutes = new Set<string>();

  for (const r of assigned) {
    const to = homeForRole(r);
    if (seenRoutes.has(to)) continue;
    seenRoutes.add(to);
    const key =
      to === '/admin'
        ? 'admin'
        : to === '/oversight'
          ? 'oversight'
          : to === '/hod'
            ? 'hod'
            : to === '/faculty'
              ? 'faculty'
              : 'student';
    portals.push({ key, to, label: PORTAL_LABELS[r] });
  }

  if (portals.length <= 1) return null;

  const wrapStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 3,
    borderRadius: 8,
    border: `1px solid ${dark ? '#3E3D39' : 'var(--border)'}`,
    background: dark ? '#242320' : 'var(--paper)',
    fontSize: 12,
  } as const;

  const itemStyle = (isActive: boolean) =>
    ({
      padding: '4px 10px',
      borderRadius: 6,
      textDecoration: 'none',
      fontWeight: isActive ? 600 : 500,
      background: isActive ? (dark ? '#FFFFFF' : '#141413') : 'transparent',
      color: isActive ? (dark ? '#141413' : '#FFFFFF') : dark ? '#CFCDC5' : 'var(--muted)',
    }) as const;

  return (
    <nav aria-label="Switch portal" style={wrapStyle}>
      {portals.map((p) => (
        <Link key={p.to} to={p.to} style={itemStyle(active === p.key)}>
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
