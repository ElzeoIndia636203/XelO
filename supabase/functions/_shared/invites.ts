export interface InvitePayloadItem {
  email: string;
  fullName: string;
  role: string;
  classCode?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function extractDomain(email: string): string {
  const norm = normalizeEmail(email);
  const at = norm.indexOf('@');
  if (at <= 0 || at === norm.length - 1) return '';
  return norm.slice(at + 1);
}

export function isStaffInviterRole(role: string): boolean {
  return ['super_admin', 'vc', 'coe', 'dean', 'hod', 'faculty'].includes(role);
}

export function canRoleInviteTarget(actorRole: string, targetRole: string): boolean {
  if (actorRole === 'super_admin') return true;
  if (['faculty', 'hod', 'dean', 'coe', 'vc'].includes(actorRole)) {
    return targetRole === 'student';
  }
  return false;
}

export function validateInviteBatch(
  items: readonly InvitePayloadItem[],
  institutionDomain: string | null,
  actorRole: string,
): { ok: true } | { ok: false; code: string; email?: string } {
  if (items.length === 0) return { ok: false, code: 'empty_batch' };
  if (items.length > 100) return { ok: false, code: 'batch_too_large' };

  const expectedDomain = institutionDomain ? institutionDomain.trim().toLowerCase() : null;
  for (const item of items) {
    const email = normalizeEmail(item.email);
    const domain = extractDomain(email);
    if (!email || !domain) {
      return { ok: false, code: 'invalid_email', email: item.email };
    }
    if (!item.fullName.trim()) {
      return { ok: false, code: 'invalid_name', email };
    }
    if (!canRoleInviteTarget(actorRole, item.role)) {
      return { ok: false, code: 'forbidden', email };
    }
    if (item.role !== 'super_admin') {
      if (!expectedDomain || domain !== expectedDomain) {
        return { ok: false, code: 'domain_mismatch', email };
      }
    }
  }
  return { ok: true };
}
