import { describe, expect, it } from 'vitest';
import { canAccessRoute, homeForRole, resolvePostLoginRoute } from '../../src/lib/logic/routing';

describe('role routing logic', () => {
  it('maps each role to its home route', () => {
    expect(homeForRole('super_admin')).toBe('/admin');
    expect(homeForRole('vc')).toBe('/oversight');
    expect(homeForRole('coe')).toBe('/oversight');
    expect(homeForRole('dean')).toBe('/oversight');
    expect(homeForRole('hod')).toBe('/hod');
    expect(homeForRole('faculty')).toBe('/faculty');
    expect(homeForRole('student')).toBe('/student');
  });

  it('keeps deep links only when allowed for the role', () => {
    expect(resolvePostLoginRoute('faculty', '/faculty/courses?tab=setup')).toBe(
      '/faculty/courses?tab=setup',
    );
    expect(resolvePostLoginRoute('student', '/admin')).toBe('/student');
    expect(resolvePostLoginRoute('hod', '/faculty')).toBe('/faculty');
    expect(canAccessRoute('student', '/verify/csl101/2301034')).toBe(true);
    expect(canAccessRoute('student', '/hod')).toBe(false);
  });
});
