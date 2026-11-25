import { describe, expect, it } from 'vitest';
import { validateInviteBatch } from '../../supabase/functions/_shared/invites';

describe('send-invites validation', () => {
  it('allows super_admin to invite matching-domain staff and allows faculty to invite matching-domain students', () => {
    expect(
      validateInviteBatch(
        [{ email: 'hod@sanjivani.edu.in', fullName: 'HOD CSE', role: 'hod' }],
        'sanjivani.edu.in',
        'super_admin',
      ),
    ).toEqual({ ok: true });

    expect(
      validateInviteBatch(
        [{ email: 'stu@sanjivani.edu.in', fullName: 'Stu 1', role: 'student', classCode: 'CS101A' }],
        'sanjivani.edu.in',
        'faculty',
      ),
    ).toEqual({ ok: true });
  });

  it('rejects domain mismatch and non-student invites from faculty', () => {
    expect(
      validateInviteBatch(
        [{ email: 'stu@gmail.com', fullName: 'Stu', role: 'student' }],
        'sanjivani.edu.in',
        'faculty',
      ),
    ).toEqual({ ok: false, code: 'domain_mismatch', email: 'stu@gmail.com' });

    expect(
      validateInviteBatch(
        [{ email: 'hod@sanjivani.edu.in', fullName: 'HOD', role: 'hod' }],
        'sanjivani.edu.in',
        'faculty',
      ),
    ).toEqual({ ok: false, code: 'forbidden', email: 'hod@sanjivani.edu.in' });
  });
});
