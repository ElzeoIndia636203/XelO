export type UserRole =
  | 'super_admin'
  | 'vc'
  | 'coe'
  | 'dean'
  | 'hod'
  | 'faculty'
  | 'student';

const ROLE_HOMES: Record<UserRole, string> = {
  super_admin: '/admin',
  vc: '/oversight',
  coe: '/oversight',
  dean: '/oversight',
  hod: '/hod',
  faculty: '/faculty',
  student: '/student',
};

const ROLE_PREFIXES: Record<UserRole, readonly string[]> = {
  super_admin: ['/admin'],
  vc: ['/oversight'],
  coe: ['/oversight'],
  dean: ['/oversight'],
  hod: ['/hod', '/faculty'],
  faculty: ['/faculty'],
  student: ['/student', '/verify'],
};

export function homeForRole(role: UserRole): string {
  return ROLE_HOMES[role];
}

export function effectiveRoles(
  primaryRole: UserRole,
  roles?: readonly UserRole[] | null,
): UserRole[] {
  const base = roles && roles.length > 0 ? [...roles] : [primaryRole];
  if (base.includes('hod') && !base.includes('faculty')) {
    base.push('faculty');
  }
  return Array.from(new Set(base));
}

export function canAccessRoute(role: UserRole, path: string): boolean {
  const clean = path.split('?')[0]?.split('#')[0] ?? '/';
  const prefixes = ROLE_PREFIXES[role];
  return prefixes.some((p) => clean === p || clean.startsWith(`${p}/`));
}

export function resolvePostLoginRoute(role: UserRole, fromPath?: string | null): string {
  if (fromPath && fromPath !== '/login' && fromPath !== '/' && canAccessRoute(role, fromPath)) {
    return fromPath;
  }
  return homeForRole(role);
}
