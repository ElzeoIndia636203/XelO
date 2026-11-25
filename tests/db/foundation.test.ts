import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const SUPER_ID = '00000000-0000-0000-0000-000000000001';
const INST_A = '10000000-0000-0000-0000-000000000001';
const INST_B = '10000000-0000-0000-0000-000000000002';
const FAC_A = '00000000-0000-0000-0000-000000000010';
const HOD_A = '00000000-0000-0000-0000-000000000011';
const STU_A = '00000000-0000-0000-0000-000000000012';
const FAC_B = '00000000-0000-0000-0000-000000000020';

async function seedBasic(db: PGlite) {
  await db.exec(`
    INSERT INTO institutions (id, name, email_domain)
    VALUES
      ('${INST_A}', 'Sanjivani University', 'sanjivani.edu.in'),
      ('${INST_B}', 'Other University', 'other.edu.in');

    INSERT INTO invites (email, institution_id, role, full_name)
    VALUES ('superadmin@elzeo.in', NULL, 'super_admin', 'Super Admin');

    INSERT INTO auth.users (id, email)
    VALUES ('${SUPER_ID}', 'superadmin@elzeo.in');
  `);

  await as(db, SUPER_ID, async () => {
    await db.query(
      `SELECT admin_invite('faculty.a@sanjivani.edu.in', 'faculty', 'Faculty A', $1, NULL, NULL)`,
      [INST_A],
    );
    await db.query(
      `SELECT admin_invite('hod.a@sanjivani.edu.in', 'hod', 'HOD A', $1, NULL, NULL)`,
      [INST_A],
    );
    await db.query(
      `SELECT admin_invite('faculty.b@other.edu.in', 'faculty', 'Faculty B', $1, NULL, NULL)`,
      [INST_B],
    );
  });

  await db.exec(`
    INSERT INTO invites (email, institution_id, role, full_name, roll_no)
    VALUES ('student.a@sanjivani.edu.in', '${INST_A}', 'student', 'Student A', '2301001');

    INSERT INTO auth.users (id, email)
    VALUES
      ('${FAC_A}', 'faculty.a@sanjivani.edu.in'),
      ('${HOD_A}', 'hod.a@sanjivani.edu.in'),
      ('${STU_A}', 'student.a@sanjivani.edu.in'),
      ('${FAC_B}', 'faculty.b@other.edu.in');
  `);
}

describe('Phase 1 Foundation DB & RLS', () => {
  it('enforces the sign-up gate: refuses uninvited and domain mismatch, accepts invite role', async () => {
    const db = await freshDb();
    await seedBasic(db);

    const noInvite = await err(
      db.exec(`INSERT INTO auth.users (id, email) VALUES ('99999999-0000-0000-0000-000000000001', 'stranger@sanjivani.edu.in');`),
    );
    expect(noInvite).toContain('not_invited');

    // Simulate tampered invite domain mismatch
    await db.exec(`
      INSERT INTO invites (email, institution_id, role, full_name)
      VALUES ('bad@gmail.com', '${INST_A}', 'faculty', 'Bad Domain');
    `);
    const badDomain = await err(
      db.exec(`INSERT INTO auth.users (id, email) VALUES ('99999999-0000-0000-0000-000000000002', 'bad@gmail.com');`),
    );
    expect(badDomain).toContain('domain_mismatch');

    const profRes = await db.query<{ role: string; active: boolean; roll_no: string | null }>(
      `SELECT role::text, active, roll_no FROM profiles WHERE id = $1`,
      [STU_A],
    );
    expect(profRes.rows[0]).toEqual({ role: 'student', active: true, roll_no: '2301001' });

    const invRes = await db.query<{ accepted_at: string | null }>(
      `SELECT accepted_at FROM invites WHERE email = 'student.a@sanjivani.edu.in'`,
    );
    expect(invRes.rows[0]?.accepted_at).not.toBeNull();
  });

  it('preflight_sign_in distinguishes ok, not_onboarded, domain_mismatch, and deactivated', async () => {
    const db = await freshDb();
    await seedBasic(db);

    await as(db, null, async () => {
      const ok = await db.query<{ res: string }>(`SELECT preflight_sign_in('faculty.a@sanjivani.edu.in') AS res`);
      const notOnboarded = await db.query<{ res: string }>(`SELECT preflight_sign_in('unknown@sanjivani.edu.in') AS res`);
      const badDom = await db.query<{ res: string }>(`SELECT preflight_sign_in('anyone@gmail.com') AS res`);
      expect(ok.rows[0]?.res).toBe('ok');
      expect(notOnboarded.rows[0]?.res).toBe('not_onboarded');
      expect(badDom.rows[0]?.res).toBe('domain_mismatch');
    });

    await as(db, SUPER_ID, async () => {
      await db.query(`SELECT admin_set_active($1, false)`, [FAC_A]);
    });

    await as(db, null, async () => {
      const deact = await db.query<{ res: string }>(`SELECT preflight_sign_in('faculty.a@sanjivani.edu.in') AS res`);
      expect(deact.rows[0]?.res).toBe('deactivated');
    });
  });

  it('restricts admin workflows to super_admin and prevents self-deactivation', async () => {
    const db = await freshDb();
    await seedBasic(db);

    for (const actor of [FAC_A, HOD_A, STU_A]) {
      const e1 = await err(
        as(db, actor, () => db.query(`SELECT admin_create_institution('X', 'x.edu.in')`)),
      );
      expect(e1).toContain('forbidden');

      const e2 = await err(
        as(db, actor, () => db.query(`SELECT admin_invite('n@sanjivani.edu.in', 'faculty', 'N', $1, NULL, NULL)`, [INST_A])),
      );
      expect(e2).toContain('forbidden');

      const e3 = await err(
        as(db, actor, () => db.query(`SELECT admin_set_active($1, false)`, [FAC_A])),
      );
      expect(e3).toContain('forbidden');
    }

    const domainErr = await err(
      as(db, SUPER_ID, () =>
        db.query(`SELECT admin_invite('wrong@gmail.com', 'faculty', 'Wrong', $1, NULL, NULL)`, [INST_A]),
      ),
    );
    expect(domainErr).toContain('domain_mismatch');

    const selfErr = await err(
      as(db, SUPER_ID, () => db.query(`SELECT admin_set_active($1, false)`, [SUPER_ID])),
    );
    expect(selfErr).toContain('cannot_deactivate_self');
  });

  it('activates subscription on approval with plan_end = start + months - 1 day', async () => {
    const db = await freshDb();
    await seedBasic(db);

    const reqId = await as(db, SUPER_ID, async () => {
      const r = await db.query<{ id: string }>(
        `SELECT admin_create_subscription_request($1, 'pro', '2027-01-04', 6, 'CSE dept') AS id`,
        [INST_A],
      );
      return r.rows[0]!.id;
    });

    await as(db, SUPER_ID, async () => {
      await db.query(`SELECT decide_subscription($1, true, 'elite', '2027-01-04', 6)`, [reqId]);
    });

    const inst = await db.query<{ plan: string; plan_start: string; plan_end: string }>(
      `SELECT plan::text, plan_start::text, plan_end::text FROM institutions WHERE id = $1`,
      [INST_A],
    );
    expect(inst.rows[0]).toEqual({
      plan: 'elite',
      plan_start: '2027-01-04',
      plan_end: '2027-07-03',
    });

    const doubleDecide = await err(
      as(db, SUPER_ID, () => db.query(`SELECT decide_subscription($1, false)`, [reqId])),
    );
    expect(doubleDecide).toContain('not_pending');
  });

  it('enforces AI credit caps (no_plan, daily_cap, total_cap) and refunds cleanly', async () => {
    const db = await freshDb();
    await seedBasic(db);

    const noPlanErr = await err(
      as(db, FAC_A, () => db.query(`SELECT consume_ai_credit('lab_candidates')`)),
    );
    expect(noPlanErr).toContain('no_plan');

    // Grant active plan starting today IST
    await as(db, SUPER_ID, async () => {
      await db.query(`SELECT admin_update_plan_caps('pro', 3, 2)`);
      const todayRes = await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`);
      const reqId = (
        await db.query<{ id: string }>(
          `SELECT admin_create_subscription_request($1, 'pro', $2, 3, 'CSE') AS id`,
          [INST_A, todayRes.rows[0]!.d],
        )
      ).rows[0]!.id;
      await db.query(`SELECT decide_subscription($1, true)`, [reqId]);
    });

    const run1 = await as(db, FAC_A, async () => {
      const r = await db.query<{ id: string }>(`SELECT consume_ai_credit('lab_candidates') AS id`);
      return r.rows[0]!.id;
    });
    await as(db, FAC_A, () => db.query(`SELECT consume_ai_credit('bank')`));

    const dailyErr = await err(
      as(db, FAC_A, () => db.query(`SELECT consume_ai_credit('class_task')`)),
    );
    expect(dailyErr).toContain('daily_cap');

    // Authenticated user cannot refund
    const refundForbidden = await err(
      as(db, FAC_A, () => db.query(`SELECT refund_ai_credit($1, 'test')`, [run1])),
    );
    expect(refundForbidden).toMatch(/permission denied|forbidden/i);

    // Service role refund frees the slot
    await as(
      db,
      null,
      () => db.query(`SELECT refund_ai_credit($1, 'validation_failed')`, [run1]),
      'service_role',
    );

    const run3 = await as(db, FAC_A, async () => {
      const r = await db.query<{ id: string }>(`SELECT consume_ai_credit('class_task') AS id`);
      return r.rows[0]!.id;
    });
    expect(run3).toBeTruthy();

    // Raise daily cap above total cap to test total_cap
    await as(db, SUPER_ID, () => db.query(`SELECT admin_update_plan_caps('pro', 2, 5)`));
    const totalErr = await err(
      as(db, FAC_A, () => db.query(`SELECT consume_ai_credit('announcement')`)),
    );
    expect(totalErr).toContain('total_cap');
  });

  it('keeps audit_log append-only and scopes approvals/audit/profiles to the institution', async () => {
    const db = await freshDb();
    await seedBasic(db);

    await db.exec(`
      INSERT INTO approvals (institution_id, object_type, object_id, approver_id, decision, remark, content_hash)
      VALUES ('${INST_B}', 'course_plan', gen_random_uuid(), '${FAC_B}', 'approved', 'ok', 'abc');
    `);

    // Audit cannot be updated or deleted
    const delAudit = await err(db.exec(`DELETE FROM audit_log;`));
    expect(delAudit).toContain('audit_immutable');

    const updAudit = await err(db.exec(`UPDATE audit_log SET action = 'tampered';`));
    expect(updAudit).toContain('audit_immutable');

    // Direct profile escalation fails
    const directEsc = await err(
      as(db, STU_A, () => db.query(`UPDATE profiles SET role = 'super_admin' WHERE id = $1`, [STU_A])),
    );
    expect(directEsc).toMatch(/permission denied|forbidden/i);

    // Faculty A cannot read Institution B approvals, profiles, or audit_log
    await as(db, FAC_A, async () => {
      const appB = await db.query(`SELECT * FROM approvals WHERE institution_id = $1`, [INST_B]);
      const profB = await db.query(`SELECT * FROM profiles WHERE id = $1`, [FAC_B]);
      expect(appB.rows).toHaveLength(0);
      expect(profB.rows).toHaveLength(0);
    });

    // Student cannot read other students/faculty, invites, approvals, or audit_log
    await as(db, STU_A, async () => {
      const profs = await db.query<{ id: string }>(`SELECT id FROM profiles`);
      const invs = await db.query<{ id: string }>(`SELECT id FROM invites`);
      const apps = await db.query<{ id: string }>(`SELECT id FROM approvals`);
      const logs = await db.query<{ id: string }>(`SELECT id FROM audit_log`);
      expect(profs.rows).toHaveLength(1);
      expect(profs.rows[0]?.id).toBe(STU_A);
      expect(invs.rows).toHaveLength(0);
      expect(apps.rows).toHaveLength(0);
      expect(logs.rows).toHaveLength(0);
    });
  });
});
