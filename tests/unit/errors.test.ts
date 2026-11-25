import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/lib/errors';

describe('error mapping', () => {
  it('maps known server error codes to plain messages', () => {
    expect(errorMessage(new Error('not_onboarded'))).toContain("isn't onboarded yet");
    expect(errorMessage(new Error('deactivated'))).toContain('deactivated');
    expect(errorMessage(new Error('daily_cap'))).toContain('midnight IST');
  });

  it('uses a generic fallback for unknown errors', () => {
    expect(errorMessage(new Error('SELECT * FROM internal_table'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
