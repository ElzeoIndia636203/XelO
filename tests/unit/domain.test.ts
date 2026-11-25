import { describe, expect, it } from 'vitest';
import { emailDomain, isDomainAllowed, parseAllowedDomains } from '../../src/lib/logic/domain';

describe('domain validation', () => {
  it('extracts lowercase domain safely', () => {
    expect(emailDomain(' Faculty.Demo@Sanjivani.EDU.IN ')).toBe('sanjivani.edu.in');
    expect(emailDomain('invalid')).toBe('');
    expect(emailDomain('@sanjivani.edu.in')).toBe('');
  });

  it('checks allowed domains list', () => {
    expect(parseAllowedDomains('sanjivani.edu.in, elzeo.in')).toEqual([
      'sanjivani.edu.in',
      'elzeo.in',
    ]);
    expect(isDomainAllowed('prof@sanjivani.edu.in', 'sanjivani.edu.in,elzeo.in')).toBe(true);
    expect(isDomainAllowed('stranger@gmail.com', 'sanjivani.edu.in,elzeo.in')).toBe(false);
    expect(isDomainAllowed('superadmin@elzeo.in', 'sanjivani.edu.in,elzeo.in')).toBe(true);
  });
});
