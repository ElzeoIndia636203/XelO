import { Link } from 'react-router-dom';

export function RolePortalToggle({
  active,
  dark = false,
}: {
  active: 'hod' | 'faculty';
  dark?: boolean;
}) {
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
      <Link to="/hod" style={itemStyle(active === 'hod')}>
        HOD console
      </Link>
      <Link to="/faculty" style={itemStyle(active === 'faculty')}>
        Faculty workspace
      </Link>
    </nav>
  );
}
