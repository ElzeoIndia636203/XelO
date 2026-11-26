import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const SUPER_ID = '00000000-0000-0000-0000-000000000001';
const INST_ID = '10000000-0000-0000-0000-000000000001';
const SCHOOL_ID = '20000000-0000-0000-0000-000000000001';
const DEPT_CSE = '30000000-0000-0000-0000-000000000001';
const DEPT_IT = '30000000-0000-0000-0000-000000000002';

const FAC_1 = '00000000-0000-0000-0000-000000000010';
const FAC_2 = '00000000-0000-0000-0000-000000000011';
const HOD_CSE = '00000000-0000-0000-0000-000000000012';
const HOD_IT = '00000000-0000-0000-0000-000000000013';
const DEAN_ID = '00000000-0000-0000-0000-000000000014';
const STU_INVITED = '00000000-0000-0000-0000-000000000020';
const STU_STRANGER = '00000000-0000-0000-0000-000000000021';

async function seedCourseEnv(db: PGlite) {
  await db.exec(`
    INSERT INTO institutions (id, name, email_domain)
    VALUES ('${INST_ID}', 'Sanjivani University', 'sanjivani.edu.in');

    INSERT INTO schools (id, institution_id, name)
    VALUES ('${SCHOOL_ID}', '${INST_ID}', 'School of Engineering and Technology');

    INSERT INTO departments (id, institution_id, school_id, code, name)
    VALUES
      ('${DEPT_CSE}', '${INST_ID}', '${SCHOOL_ID}', 'CSE', 'Computer Science and Engineering'),
      ('${DEPT_IT}', '${INST_ID}', '${SCHOOL_ID}', 'IT', 'Information Technology');

    INSERT INTO invites (email, institution_id, role, full_name, school_id, department_id, roll_no)
    VALUES
      ('superadmin@elzeo.in', NULL, 'super_admin', 'Super Admin', NULL, NULL, NULL),
      ('fac1@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty One', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('fac2@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty Two', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('hod.cse@sanjivani.edu.in', '${INST_ID}', 'hod', 'HOD CSE', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('hod.it@sanjivani.edu.in', '${INST_ID}', 'hod', 'HOD IT', '${SCHOOL_ID}', '${DEPT_IT}', NULL),
      ('dean@sanjivani.edu.in', '${INST_ID}', 'dean', 'Dean SET', '${SCHOOL_ID}', NULL, NULL),
      ('stu.invited@sanjivani.edu.in', '${INST_ID}', 'student', 'Invited Student', '${SCHOOL_ID}', '${DEPT_CSE}', '2301999');

    INSERT INTO auth.users (id, email) VALUES
      ('${SUPER_ID}', 'superadmin@elzeo.in'),
      ('${FAC_1}', 'fac1@sanjivani.edu.in'),
      ('${FAC_2}', 'fac2@sanjivani.edu.in'),
      ('${HOD_CSE}', 'hod.cse@sanjivani.edu.in'),
      ('${HOD_IT}', 'hod.it@sanjivani.edu.in'),
      ('${DEAN_ID}', 'dean@sanjivani.edu.in'),
      ('${STU_INVITED}', 'stu.invited@sanjivani.edu.in');

    INSERT INTO institutions (id, name, email_domain)
    VALUES ('10000000-0000-0000-0000-000000000099', 'Other Inst', 'other.edu.in');
    INSERT INTO invites (email, institution_id, role, full_name, roll_no)
    VALUES ('other.stu@other.edu.in', '10000000-0000-0000-0000-000000000099', 'student', 'Other Stu', '9901');
    INSERT INTO auth.users (id, email) VALUES ('${STU_STRANGER}', 'other.stu@other.edu.in');
  `);
}

describe('Phase 2 Course Plan DB & RLS', () => {
  it('enforces rubric = 50, outcomes required, plan locks on send, and HOD approval with content hash', async () => {
    const db = await freshDb();
    await seedCourseEnv(db);

    // Direct INSERT RETURNING works because courses_read includes faculty_id = auth.uid()
    const courseId = await as(db, FAC_1, async () => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO courses (institution_id, department_id, faculty_id, code, title)
         VALUES ($1, $2, $3, 'CSL-101', 'Programming in C Lab')
         RETURNING id`,
        [INST_ID, DEPT_CSE, FAC_1],
      );
      return r.rows[0]!.id;
    });

    // Cannot submit without COs
    const noCos = await err(as(db, FAC_1, () => db.query(`SELECT submit_course_plan($1)`, [courseId])));
    expect(noCos).toContain('outcomes_required');

    // Add a CO and CO-PO map, then break rubric sum
    await as(db, FAC_1, async () => {
      const co = await db.query<{ id: string }>(
        `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
         VALUES ($1, $2, 'CO1', 'Write C programs', 3, 1) RETURNING id`,
        [courseId, INST_ID],
      );
      await db.query(
        `INSERT INTO co_po_map (course_id, institution_id, co_id, po_code, level)
         VALUES ($1, $2, $3, 'PO1', 3)`,
        [courseId, INST_ID, co.rows[0]!.id],
      );
      await db.query(
        `UPDATE courses SET rubric = '{"att":10,"pre":5,"post":5,"vis":10,"hid":10,"viva":5}'::jsonb WHERE id = $1`,
        [courseId],
      );
    });

    const badRubric = await err(as(db, FAC_1, () => db.query(`SELECT submit_course_plan($1)`, [courseId])));
    expect(badRubric).toContain('rubric_must_total_50');

    // Direct status escalation fails
    const statusBypass = await err(
      as(db, FAC_1, () => db.query(`UPDATE courses SET plan_status = 'approved' WHERE id = $1`, [courseId])),
    );
    expect(statusBypass).toContain('forbidden');

    // Restore 50 and submit
    await as(db, FAC_1, async () => {
      await db.query(
        `UPDATE courses SET rubric = '{"att":10,"pre":5,"post":5,"vis":10,"hid":10,"viva":10}'::jsonb WHERE id = $1`,
        [courseId],
      );
      await db.query(`SELECT submit_course_plan($1)`, [courseId]);
    });

    // Plan is locked once sent
    const lockedEdit = await err(
      as(db, FAC_1, () => db.query(`UPDATE courses SET title = 'Hacked' WHERE id = $1`, [courseId])),
    );
    expect(lockedEdit).toContain('plan_locked');

    const lockedCoEdit = await err(
      as(db, FAC_1, () =>
        db.query(
          `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
           VALUES ($1, $2, 'CO2', 'Loops', 3, 2)`,
          [courseId, INST_ID],
        ),
      ),
    );
    expect(lockedCoEdit).toContain('plan_locked');

    // Faculty, other-dept HOD, and Dean cannot decide
    for (const actor of [FAC_1, FAC_2, HOD_IT, DEAN_ID]) {
      const e = await err(as(db, actor, () => db.query(`SELECT decide_course_plan($1, true)`, [courseId])));
      expect(e).toContain('forbidden');
    }

    // Declining without remark fails
    const noRemark = await err(
      as(db, HOD_CSE, () => db.query(`SELECT decide_course_plan($1, false, '   ')`, [courseId])),
    );
    expect(noRemark).toContain('remark_required');

    // Declining with remark works and writes approval row
    await as(db, HOD_CSE, () =>
      db.query(`SELECT decide_course_plan($1, false, 'Add CO2 for loops')`, [courseId]),
    );

    // Editing a declined plan resets it to draft
    await as(db, FAC_1, () =>
      db.query(
        `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
         VALUES ($1, $2, 'CO2', 'Loops', 3, 2)`,
        [courseId, INST_ID],
      ),
    );
    const afterEdit = await db.query<{ plan_status: string }>(
      `SELECT plan_status::text FROM courses WHERE id = $1`,
      [courseId],
    );
    expect(afterEdit.rows[0]?.plan_status).toBe('draft');

    // Resubmit and approve
    await as(db, FAC_1, () => db.query(`SELECT submit_course_plan($1)`, [courseId]));
    await as(db, HOD_CSE, () => db.query(`SELECT decide_course_plan($1, true, 'Looks good')`, [courseId]));

    const approved = await db.query<{ plan_status: string }>(
      `SELECT plan_status::text FROM courses WHERE id = $1`,
      [courseId],
    );
    expect(approved.rows[0]?.plan_status).toBe('approved');

    const appRows = await db.query<{ decision: string; content_hash: string }>(
      `SELECT decision::text, content_hash FROM approvals WHERE object_id = $1 ORDER BY at`,
      [courseId],
    );
    expect(appRows.rows).toHaveLength(2);
    expect(appRows.rows[0]?.decision).toBe('declined');
    expect(appRows.rows[1]?.decision).toBe('approved');
    expect(appRows.rows[1]?.content_hash).toHaveLength(64);
  });

  it('splits 126 students 63/63, rejects wrong domains, auto-enrolls on signup, and enforces join_with_code', async () => {
    const db = await freshDb();
    await seedCourseEnv(db);

    const courseId = await as(db, FAC_1, async () => {
      const r = await db.query<{ id: string }>(
        `SELECT create_course('CSL-101', 'Programming in C Lab') AS id`,
      );
      return r.rows[0]!.id;
    });

    // External-domain students are rejected by default, and only gmail/outlook are allowed when p_allow_personal = true
    const extRoster = [
      { roll_no: '2301001', full_name: 'External', email: 'ext@gmail.com' },
    ];
    await expect(
      as(db, FAC_1, () =>
        db.query(`SELECT * FROM import_roster($1, $2::jsonb)`, [courseId, JSON.stringify(extRoster)]),
      ),
    ).rejects.toThrow(/domain_mismatch/);

    await expect(
      as(db, FAC_1, () =>
        db.query(`SELECT * FROM import_roster($1, $2::jsonb, true)`, [
          courseId,
          JSON.stringify([{ roll_no: '2301002', full_name: 'Yahoo', email: 'ext@yahoo.com' }]),
        ]),
      ),
    ).rejects.toThrow(/domain_mismatch/);

    const extBatches = await as(db, FAC_1, () =>
      db.query(`SELECT * FROM import_roster($1, $2::jsonb, true)`, [courseId, JSON.stringify(extRoster)]),
    );
    expect(extBatches.rows.length).toBe(1);

    // 126 valid students split 63 + 63
    const roster = Array.from({ length: 126 }, (_, i) => ({
      roll_no: `2301${String(i + 1).padStart(3, '0')}`,
      full_name: `Student ${i + 1}`,
      email: `s${i + 1}@sanjivani.edu.in`,
    }));

    const batches = await as(db, FAC_1, async () => {
      const r = await db.query<{ batch_id: string; batch_name: string; class_code: string; student_count: number }>(
        `SELECT * FROM import_roster($1, $2::jsonb)`,
        [courseId, JSON.stringify(roster)],
      );
      return r.rows;
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.student_count).toBe(63);
    expect(batches[1]?.student_count).toBe(63);
    expect(batches[0]?.class_code).toHaveLength(6);

    // Student cannot read pending_enrollments
    await as(db, STU_INVITED, async () => {
      const pe = await db.query(`SELECT * FROM pending_enrollments`);
      expect(pe.rows).toHaveLength(0);
    });

    // Pending student signs up -> auto-enrolled via handle_new_user()
    const newStuUid = '00000000-0000-0000-0000-000000000088';
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${newStuUid}', 's1@sanjivani.edu.in');`);
    const enr = await db.query<{ batch_id: string }>(
      `SELECT batch_id FROM enrollments WHERE course_id = $1 AND student_id = $2`,
      [courseId, newStuUid],
    );
    expect(enr.rows[0]?.batch_id).toBe(batches[0]!.batch_id);

    // Move student to Batch B
    await as(db, FAC_1, () =>
      db.query(`SELECT move_student($1, 's1@sanjivani.edu.in', $2)`, [courseId, batches[1]!.batch_id]),
    );
    const moved = await db.query<{ batch_id: string }>(
      `SELECT batch_id FROM enrollments WHERE course_id = $1 AND student_id = $2`,
      [courseId, newStuUid],
    );
    expect(moved.rows[0]?.batch_id).toBe(batches[1]!.batch_id);

    // Invited same-institution student joins via class code
    const joinedCourse = await as(db, STU_INVITED, async () => {
      const r = await db.query<{ id: string }>(`SELECT join_with_code($1) AS id`, [batches[0]!.class_code]);
      return r.rows[0]!.id;
    });
    expect(joinedCourse).toBe(courseId);

    // Student from other institution refused
    const strangerErr = await err(
      as(db, STU_STRANGER, () => db.query(`SELECT join_with_code($1)`, [batches[0]!.class_code])),
    );
    expect(strangerErr).toContain('not_on_roster');

    // Invalid code refused
    const badCodeErr = await err(
      as(db, STU_INVITED, () => db.query(`SELECT join_with_code('BAD999')`)),
    );
    expect(badCodeErr).toContain('invalid_class_code');
  });

  it('save_session_plan is owner-only and locks once any session is active', async () => {
    const db = await freshDb();
    await seedCourseEnv(db);

    const courseId = await as(db, FAC_1, async () => {
      const r = await db.query<{ id: string }>(`SELECT create_course('CSL-101', 'Programming in C Lab') AS id`);
      return r.rows[0]!.id;
    });

    const otherFacErr = await err(
      as(db, FAC_2, () =>
        db.query(`SELECT save_session_plan($1, ARRAY['Topic 1'], ARRAY['2027-01-06']::date[])`, [courseId]),
      ),
    );
    expect(otherFacErr).toContain('forbidden');

    await as(db, FAC_1, () =>
      db.query(
        `SELECT save_session_plan($1, ARRAY['Input and output', 'Operators'], ARRAY['2027-01-06', '2027-01-06']::date[])`,
        [courseId],
      ),
    );

    const sessRes = await db.query<{ n: number; topic: string; scheduled_date: string }>(
      `SELECT n, topic, scheduled_date::text FROM sessions WHERE course_id = $1 ORDER BY n`,
      [courseId],
    );
    expect(sessRes.rows).toEqual([
      { n: 1, topic: 'Input and output', scheduled_date: '2027-01-06' },
      { n: 2, topic: 'Operators', scheduled_date: '2027-01-06' },
    ]);

    // Direct sessions mutation fails
    const directSessErr = await err(
      as(db, FAC_1, () => db.query(`UPDATE sessions SET status = 'active' WHERE course_id = $1`, [courseId])),
    );
    expect(directSessErr).toMatch(/permission denied|forbidden/i);

    // Once active (simulated by service_role), save_session_plan refuses
    await db.exec(`UPDATE sessions SET status = 'active' WHERE course_id = '${courseId}' AND n = 1;`);
    const activeErr = await err(
      as(db, FAC_1, () =>
        db.query(`SELECT save_session_plan($1, ARRAY['New'], ARRAY['2027-01-13']::date[])`, [courseId]),
      ),
    );
    expect(activeErr).toContain('sessions_already_active');
  });
});
