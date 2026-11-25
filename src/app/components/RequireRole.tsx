import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loading } from '../../components/ui';
import { effectiveRoles, homeForRole, type UserRole } from '../../lib/logic/routing';
import { useSession } from '../../lib/session';

export function RequireRole({
  allow,
  children,
}: {
  allow: readonly UserRole[];
  children: ReactNode;
}) {
  const { session, profile, restored } = useSession();
  const location = useLocation();

  if (!restored) {
    return (
      <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Restoring session…" />
      </main>
    );
  }

  if (!session || !profile) {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" state={{ from }} replace />;
  }

  const assigned = effectiveRoles(profile.role, profile.roles);
  if (!assigned.some((r) => allow.includes(r))) {
    return <Navigate to={homeForRole(profile.role)} replace />;
  }

  return <>{children}</>;
}
