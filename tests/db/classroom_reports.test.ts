import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { as, freshDb } from './harness';

const INST_ID = '10000000-0000-0000-0000-000000000001';
const SCHOOL_ID = '20000000-0000-0000-0000-000000000001';
const DEPT_CSE = '30000000-0000-0000-0000-000000000001';

const FAC_1 = '00000000-0000-0000-0000-000000000010';
const HOD_1 = '00000000-0000-0000-0000-000000000012';
const COE_1 = '00000000-0000-0000-0000-000000000013';
const STU_1 = '00000000-0000-0000-0000-000000000020';
const STU_2 = '00000000-0000-0000-0000-000000000021';

async function setupCourse(db: PGlite) {
  await db.exec(`
    INSERT INTO institutions (id, name, email_domain, plan, plan_start, plan_end)
    VALUES ('${INST_ID}', 'Sanjivani University', 'sanjivani.edu.in', 'pro', CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date);
    INSERT INTO schools (id, institution_id, name) VALUES ('${SCHOOL_ID}', '${INST_ID}', 'SET');
    INSERT INTO departments (id, institution_id, school_id, code, name) VALUES ('${DEPT_CSE}', '${INST_ID}', '${SCHOOL_ID}', 'CSE', 'CSE');

    INSERT INTO invites (email, institution_id, role, full_name, school_id, department_id, roll_no) VALUES
      ('fac1@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty One', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('hod1@sanjivani.edu.in', '${INST_ID}', 'hod', 'HOD CSE', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('coe1@sanjivani.edu.in', '${INST_ID}', 'coe', 'CoE', '${SCHOOL_ID}', NULL, NULL),
      ('stu1@sanjivani.edu.in', '${INST_ID}', 'student', 'Student One', '${SCHOOL_ID}', '${DEPT_CSE}', '2301001'),
      ('stu2@sanjivani.edu.in', '${INST_ID}', 'student', 'Student Two', '${SCHOOL_ID}', '${DEPT_CSE}', '2301002');

    INSERT INTO auth.users (id, email) VALUES
      ('${FAC_1}', 'fac1@sanjivani.edu.in'),
      ('${HOD_1}', 'hod1@sanjivani.edu.in'),
      ('${COE_1}', 'coe1@sanjivani.edu.in'),
      ('${STU_1}', 'stu1@sanjivani.edu.in'),
      ('${STU_2}', 'stu2@sanjivani.edu.in');
  `);

  const courseId = await as(db, FAC_1, () =>
    db
      .query<{ id: string }>(
        `SELECT create_course('CSL-101', 'Programming in C Lab', '0-0-2-1', 'B.Tech', 'IV', 'SY-B', '2026-27', $1) AS id`,
        [DEPT_CSE],
      )
      .then((r) => r.rows[0]!.id),
  );

  await as(db, FAC_1, async () => {
    const coRes = await db.query<{ id: string }>(
      `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
       VALUES ($1, $2, 'CO1', 'Apply C fundamentals', 3, 1) RETURNING id`,
      [courseId, INST_ID],
    );
    await db.query(
      `INSERT INTO co_po_map (course_id, institution_id, co_id, po_code, level) VALUES ($1, $2, $3, 'PO1', 3)`,
      [courseId, INST_ID, coRes.rows[0]!.id],
    );
    await db.query(`SELECT submit_course_plan($1)`, [courseId]);
  });

  await db.exec(`
    INSERT INTO batches (id, course_id, institution_id, name, class_code, slot, room, staff) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${courseId}', '${INST_ID}', 'Batch A', 'BATCHA', 'Wed 10:00', 'Lab 3', 'Faculty + TA1');

    INSERT INTO enrollments (course_id, batch_id, institution_id, student_id) VALUES
      ('${courseId}', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${INST_ID}', '${STU_1}');
  `);

  return courseId;
}

describe('Phase 5 Classroom, Reports, Notifications & Calendar DB & RLS', () => {
  it('hides class_answer_keys from students and grades submit_class_response server-side', async () => {
    const db = await freshDb();
    const courseId = await setupCourse(db);
    await as(db, HOD_1, () => db.query(`SELECT decide_course_plan($1, true, 'Approved')`, [courseId]));

    // Faculty creates a quiz and a debug task
    const quizId = await as(db, FAC_1, () =>
      db
        .query<{ id: string }>(
          `SELECT create_class_item($1, 1, 'task', 'quiz', 'Loop complexity', 'Pick the best answer', $2::jsonb, NULL, NULL, NULL, $3::jsonb) AS id`,
          [courseId, JSON.stringify({ options: ['O(1)', 'O(n)', 'O(n^2)'] }), JSON.stringify({ expected: '1' })],
        )
        .then((r) => r.rows[0]!.id),
    );

    // Reject http:// external resource URLs
    await expect(
      as(db, FAC_1, () =>
        db.query(
          `SELECT create_class_item($1, 1, 'resource', NULL, 'Bad link', '', '{}'::jsonb, NULL, 'http://example.com/a.pdf', NULL, NULL)`,
          [courseId],
        ),
      ),
    ).rejects.toThrow(/invalid_input/);

    // Faculty can read answer keys; enrolled student cannot
    const facKeys = await as(db, FAC_1, () =>
      db.query(`SELECT * FROM class_answer_keys WHERE item_id = $1`, [quizId]),
    );
    expect(facKeys.rows).toHaveLength(1);

    const stuKeys = await as(db, STU_1, () =>
      db.query(`SELECT * FROM class_answer_keys WHERE item_id = $1`, [quizId]),
    );
    expect(stuKeys.rows).toHaveLength(0);

    // Unenrolled student cannot respond
    await expect(
      as(db, STU_2, () =>
        db.query(`SELECT submit_class_response($1, $2::jsonb)`, [quizId, JSON.stringify({ value: '1' })]),
      ),
    ).rejects.toThrow(/forbidden/);

    // Wrong answer gives 0; right answer gives 1
    const s0 = await as(db, STU_1, () =>
      db
        .query<{ s: number }>(`SELECT submit_class_response($1, $2::jsonb)::int AS s`, [
          quizId,
          JSON.stringify({ value: '0' }),
        ])
        .then((r) => r.rows[0]!.s),
    );
    expect(s0).toBe(0);

    const s1 = await as(db, STU_1, () =>
      db
        .query<{ s: number }>(`SELECT submit_class_response($1, $2::jsonb)::int AS s`, [
          quizId,
          JSON.stringify({ value: '1' }),
        ])
        .then((r) => r.rows[0]!.s),
    );
    expect(s1).toBe(1);

    // Verify private storage path validator accepts matching course UUID prefix only
    const parsedUuid = await db
      .query<{ id: string | null }>(`SELECT storage_course_id_from_path($1) AS id`, [`${courseId}/1234-notes.pdf`])
      .then((r) => r.rows[0]!.id);
    expect(parsedUuid).toBe(courseId);
  });

  it('routes notifications for course plans and final marks, isolates users, and enforces HOD -> CoE pipeline with remarks', async () => {
    const db = await freshDb();
    const courseId = await setupCourse(db);

    // Submitting course plan created a notification for HOD_1
    const hodNotifsBefore = await as(db, HOD_1, () =>
      db.query<{ kind: string; link: string }>(`SELECT kind, link FROM notifications WHERE user_id = $1`, [HOD_1]),
    );
    expect(hodNotifsBefore.rows.some((r) => r.kind === 'plan_sent' && r.link.startsWith('/'))).toBe(true);

    // Faculty cannot read HOD's notification
    const crossRead = await as(db, FAC_1, () =>
      db.query(`SELECT * FROM notifications WHERE user_id = $1`, [HOD_1]),
    );
    expect(crossRead.rows).toHaveLength(0);

    // Authenticated user cannot insert fake notifications or tamper with title
    await expect(
      as(db, STU_1, () =>
        db.query(
          `INSERT INTO notifications (institution_id, user_id, kind, title, body, link)
           VALUES ($1, $2, 'hint', 'Fake', 'Body', '/student')`,
          [INST_ID, STU_1],
        ),
      ),
    ).rejects.toThrow();

    // Final marks cannot be submitted until plan is approved
    await expect(as(db, FAC_1, () => db.query(`SELECT submit_final_marks($1)`, [courseId]))).rejects.toThrow(
      /plan_not_approved/,
    );

    await as(db, HOD_1, () => db.query(`SELECT decide_course_plan($1, true, 'Plan approved')`, [courseId]));

    // Faculty received plan decision notification
    const facPlanNotif = await as(db, FAC_1, () =>
      db.query<{ kind: string }>(`SELECT kind FROM notifications WHERE user_id = $1`, [FAC_1]),
    );
    expect(facPlanNotif.rows.some((r) => r.kind === 'plan_decision')).toBe(true);

    // Submit final marks -> HOD notifies -> CoE cannot decide before HOD
    await as(db, FAC_1, () => db.query(`SELECT submit_final_marks($1)`, [courseId]));
    await expect(as(db, COE_1, () => db.query(`SELECT decide_final_marks($1, true, 'Early')`, [courseId]))).rejects.toThrow(
      /forbidden/,
    );

    // HOD must give a remark to return
    await expect(as(db, HOD_1, () => db.query(`SELECT decide_final_marks($1, false, '')`, [courseId]))).rejects.toThrow(
      /remark_required/,
    );

    // HOD approves -> status becomes hod_approved and CoE receives notification
    await as(db, HOD_1, () => db.query(`SELECT decide_final_marks($1, true, 'Verified')`, [courseId]));
    const coeNotifs = await as(db, COE_1, () =>
      db.query<{ kind: string }>(`SELECT kind FROM notifications WHERE user_id = $1`, [COE_1]),
    );
    expect(coeNotifs.rows.some((r) => r.kind === 'final_marks_coe')).toBe(true);

    // CoE returns without remark fails -> returns with remark succeeds
    await expect(as(db, COE_1, () => db.query(`SELECT decide_final_marks($1, false, NULL)`, [courseId]))).rejects.toThrow(
      /remark_required/,
    );
    await as(db, COE_1, () => db.query(`SELECT decide_final_marks($1, false, 'Recheck CO2 sheet')`, [courseId]));

    // Resubmit -> HOD approves -> CoE accepts
    await as(db, FAC_1, () => db.query(`SELECT submit_final_marks($1)`, [courseId]));
    await as(db, HOD_1, () => db.query(`SELECT decide_final_marks($1, true, 'Fixed')`, [courseId]));
    await as(db, COE_1, () => db.query(`SELECT decide_final_marks($1, true, 'Accepted')`, [courseId]));

    const finalState = await db.query<{ final_status: string }>(`SELECT final_status FROM courses WHERE id = $1`, [
      courseId,
    ]);
    expect(finalState.rows[0]!.final_status).toBe('coe_accepted');
  });

  it('scopes calendar_events to valid tokens, rotates tokens to invalidate old links, and exposes safe anon verify_lab_file', async () => {
    const db = await freshDb();
    const courseId = await setupCourse(db);
    await as(db, HOD_1, () => db.query(`SELECT decide_course_plan($1, true, 'OK')`, [courseId]));
    await as(db, FAC_1, () =>
      db.query(`SELECT save_session_plan($1, ARRAY['Intro I/O'], ARRAY[CURRENT_DATE]::date[])`, [courseId]),
    );

    const oldToken = await as(db, STU_1, () =>
      db
        .query<{ calendar_token: string }>(`SELECT calendar_token FROM profiles WHERE id = $1`, [STU_1])
        .then((r) => r.rows[0]!.calendar_token),
    );

    // authenticated and anon users cannot call calendar_events directly
    await expect(
      as(db, STU_1, () => db.query(`SELECT * FROM calendar_events($1)`, [oldToken])),
    ).rejects.toThrow();
    await expect(
      as(db, null, () => db.query(`SELECT * FROM calendar_events($1)`, [oldToken]), 'anon'),
    ).rejects.toThrow();

    // Direct calendar_token tampering rejected by guard_profiles_update
    await expect(
      as(db, STU_1, () =>
        db.query(`UPDATE profiles SET calendar_token = gen_random_uuid() WHERE id = $1`, [STU_1]),
      ),
    ).rejects.toThrow();

    // service_role fetches events with oldToken
    const eventsBefore = await as(
      db,
      null,
      () => db.query<{ summary: string }>(`SELECT summary FROM calendar_events($1)`, [oldToken]),
      'service_role',
    );
    expect(eventsBefore.rows).toHaveLength(1);
    expect(eventsBefore.rows[0]!.summary).toContain('CSL-101');

    // Rotating invalidates oldToken and activates newToken
    const newToken = await as(db, STU_1, () =>
      db.query<{ t: string }>(`SELECT rotate_calendar_token() AS t`).then((r) => r.rows[0]!.t),
    );
    expect(newToken).not.toBe(oldToken);

    await expect(
      as(db, null, () => db.query(`SELECT * FROM calendar_events($1)`, [oldToken]), 'service_role'),
    ).rejects.toThrow(/invalid_token/);

    const eventsAfter = await as(
      db,
      null,
      () => db.query<{ summary: string }>(`SELECT summary FROM calendar_events($1)`, [newToken]),
      'service_role',
    );
    expect(eventsAfter.rows).toHaveLength(1);

    // Anon can verify enrolled student's lab file cleanly without seeing other private rows
    const verifyRes = await as(db, null, () =>
      db
        .query<{ res: { found: boolean; course_code: string; roll_no: string; verification_code: string } }>(
          `SELECT verify_lab_file($1, $2) AS res`,
          [courseId, STU_1],
        )
        .then((r) => r.rows[0]!.res),
    );
    expect(verifyRes.found).toBe(true);
    expect(verifyRes.course_code).toBe('CSL-101');
    expect(verifyRes.roll_no).toBe('2301001');
    expect(verifyRes.verification_code).toMatch(/^XO-CSL101-2301001-[0-9A-F]{4}$/);
  });
});
