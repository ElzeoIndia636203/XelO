export function emailDomain(email: string): string {
  const clean = email.trim().toLowerCase();
  const idx = clean.indexOf('@');
  if (idx <= 0 || idx === clean.length - 1) return '';
  return clean.slice(idx + 1);
}

export function parseAllowedDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isDomainAllowed(email: string, allowedDomainsRaw: string | undefined): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const allowed = parseAllowedDomains(allowedDomainsRaw);
  if (allowed.length === 0) return true;
  return allowed.includes(domain);
}
