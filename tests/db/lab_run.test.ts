import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const INST_ID = '10000000-0000-0000-0000-000000000001';
const SCHOOL_ID = '20000000-0000-0000-0000-000000000001';
const DEPT_CSE = '30000000-0000-0000-0000-000000000001';

const FAC_1 = '00000000-0000-0000-0000-000000000010';
const HOD_1 = '00000000-0000-0000-0000-000000000012';
const STU_A1 = '00000000-0000-0000-0000-000000000020';
const STU_A2 = '00000000-0000-0000-0000-000000000021';
const STU_B1 = '00000000-0000-0000-0000-000000000022';

async function setupActiveLab(db: PGlite) {
  await db.exec(`
    INSERT INTO institutions (id, name, email_domain, plan, plan_start, plan_end)
    VALUES ('${INST_ID}', 'Sanjivani University', 'sanjivani.edu.in', 'pro', CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date);
    INSERT INTO schools (id, institution_id, name) VALUES ('${SCHOOL_ID}', '${INST_ID}', 'SET');
    INSERT INTO departments (id, institution_id, school_id, code, name) VALUES ('${DEPT_CSE}', '${INST_ID}', '${SCHOOL_ID}', 'CSE', 'CSE');

    INSERT INTO invites (email, institution_id, role, full_name, school_id, department_id, roll_no) VALUES
      ('fac1@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty One', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('hod1@sanjivani.edu.in', '${INST_ID}', 'hod', 'HOD CSE', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('stua1@sanjivani.edu.in', '${INST_ID}', 'student', 'Stu A1', '${SCHOOL_ID}', '${DEPT_CSE}', '2301001'),
      ('stua2@sanjivani.edu.in', '${INST_ID}', 'student', 'Stu A2', '${SCHOOL_ID}', '${DEPT_CSE}', '2301002'),
      ('stub1@sanjivani.edu.in', '${INST_ID}', 'student', 'Stu B1', '${SCHOOL_ID}', '${DEPT_CSE}', '2301003');

    INSERT INTO auth.users (id, email) VALUES
      ('${FAC_1}', 'fac1@sanjivani.edu.in'),
      ('${HOD_1}', 'hod1@sanjivani.edu.in'),
      ('${STU_A1}', 'stua1@sanjivani.edu.in'),
      ('${STU_A2}', 'stua2@sanjivani.edu.in'),
      ('${STU_B1}', 'stub1@sanjivani.edu.in');
  `);

  const courseId = await as(db, FAC_1, () =>
    db
      .query<{ id: string }>(`SELECT create_course('CSL-101', 'C Lab', '0-0-2-1', 'B.Tech', 'IV', 'SY-B', '2026-27', $1) AS id`, [DEPT_CSE])
      .then((r) => r.rows[0]!.id),
  );

  await as(db, FAC_1, async () => {
    const coRes = await db.query<{ id: string }>(
      `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
       VALUES ($1, $2, 'CO1', 'Write C programs', 3, 1) RETURNING id`,
      [courseId, INST_ID],
    );
    await db.query(
      `INSERT INTO co_po_map (course_id, institution_id, co_id, po_code, level) VALUES ($1, $2, $3, 'PO1', 3)`,
      [courseId, INST_ID, coRes.rows[0]!.id],
    );
    await db.query(`SELECT submit_course_plan($1)`, [courseId]);
  });

  await as(db, HOD_1, () => db.query(`SELECT decide_course_plan($1, true, 'OK')`, [courseId]));

  // Put STU_A1 & STU_A2 in Batch A and STU_B1 in Batch B
  await db.exec(`
    INSERT INTO batches (id, course_id, institution_id, name, class_code, slot, room, staff) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${courseId}', '${INST_ID}', 'Batch A', 'BATCHA', 'Wed 10:00', 'Lab 3', 'Faculty + TA1'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${courseId}', '${INST_ID}', 'Batch B', 'BATCHB', 'Wed 14:00', 'Lab 4', 'Faculty + TA2');

    INSERT INTO enrollments (course_id, batch_id, institution_id, student_id) VALUES
      ('${courseId}', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${INST_ID}', '${STU_A1}'),
      ('${courseId}', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${INST_ID}', '${STU_A2}'),
      ('${courseId}', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${INST_ID}', '${STU_B1}');
  `);

  await as(db, FAC_1, () =>
    db.query(`SELECT save_session_plan($1, ARRAY['Loops lab'], ARRAY[CURRENT_DATE]::date[])`, [courseId]),
  );

  const sessId = await db
    .query<{ id: string }>(`SELECT id FROM sessions WHERE course_id = $1`, [courseId])
    .then((r) => r.rows[0]!.id);

  const makeQ = async (title: string) => {
    const qid = await as(db, FAC_1, () =>
      db
        .query<{ id: string }>(
          `SELECT save_own_question($1, $2::jsonb) AS id`,
          [
            sessId,
            JSON.stringify({
              title,
              statement: 'Print double n',
              difficulty: 'medium',
              co_code: 'CO1',
              visible_tests: [
                { input: '1', expected: '2' },
                { input: '2', expected: '4' },
              ],
              hidden_tests: [
                { input: '3', expected: '6' },
                { input: '4', expected: '8' },
                { input: '5', expected: '10' },
              ],
              references: { c: 'int main(){return 0;}' },
            }),
          ],
        )
        .then((r) => r.rows[0]!.id),
    );
    await db.query(`UPDATE questions SET valid = true WHERE id = $1`, [qid]);
    return qid;
  };

  const q1 = await makeQ('Lab Q1');
  const q2 = await makeQ('Lab Q2');
  await as(db, FAC_1, () => db.query(`SELECT pick_session_questions($1, $2, $3)`, [sessId, q1, q2]));

  for (const bank of ['pre', 'post'] as const) {
    const items = (['easy', 'medium', 'hard'] as const).flatMap((level) =>
      Array.from({ length: 15 }, (_, i) => ({
        bank,
        level,
        stem:
          bank === 'pre'
            ? `Pre readiness check concept ${level} case ${i + 1}`
            : `Post runtime analysis complexity ${level} step ${i + 1}`,
        options: ['A0', 'B1', 'C2', 'D3'],
        answer: 2,
      })),
    );
    await as(db, FAC_1, () => db.query(`SELECT import_bank_items($1, $2::jsonb)`, [sessId, JSON.stringify(items)]));
    await as(db, FAC_1, () => db.query(`SELECT approve_bank($1, $2)`, [sessId, bank]));
  }

  return {
    courseId,
    sessId,
    batchA: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    batchB: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    q1,
    q2,
  };
}

describe('Phase 4 Lab Run DB & RLS', () => {
  it('runs check-in, suggested attendance, batch-only save_attendance, idempotent start_session_run, viva cap, and batch-scoped hints', async () => {
    const db = await freshDb();
    const { sessId, batchA, q1 } = await setupActiveLab(db);

    // STU_A1 checks in
    await as(db, STU_A1, () => db.query(`SELECT lab_checkin($1)`, [sessId]));

    // Start run idempotently
    const run1 = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT start_session_run($1, $2) AS id`, [sessId, batchA]).then((r) => r.rows[0]!.id),
    );
    const run2 = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT start_session_run($1, $2) AS id`, [sessId, batchA]).then((r) => r.rows[0]!.id),
    );
    expect(run1).toBe(run2);

    // started_at stays null before attendance
    const beforeAtt = await db.query<{ started_at: string | null }>(`SELECT started_at FROM session_runs WHERE id = $1`, [run1]);
    expect(beforeAtt.rows[0]!.started_at).toBeNull();

    // Check-in suggests present for STU_A1 and absent for STU_A2
    const suggested = await as(db, FAC_1, () =>
      db.query<{ student_id: string; suggested_state: string }>(`SELECT student_id, suggested_state::text FROM suggest_attendance($1)`, [run1]),
    );
    expect(suggested.rows.find((r) => r.student_id === STU_A1)?.suggested_state).toBe('present');
    expect(suggested.rows.find((r) => r.student_id === STU_A2)?.suggested_state).toBe('absent');

    // Cross-batch student (STU_B1) refused in save_attendance
    const badBatchErr = await err(
      as(db, FAC_1, () =>
        db.query(`SELECT save_attendance($1, $2::jsonb)`, [
          run1,
          JSON.stringify([{ student_id: STU_B1, state: 'present' }]),
        ]),
      ),
    );
    expect(badBatchErr).toContain('forbidden');

    // Confirm attendance for STU_A1 present, STU_A2 absent
    await as(db, FAC_1, () =>
      db.query(`SELECT save_attendance($1, $2::jsonb)`, [
        run1,
        JSON.stringify([
          { student_id: STU_A1, state: 'present' },
          { student_id: STU_A2, state: 'absent' },
        ]),
      ]),
    );

    const afterAtt = await db.query<{ attendance_done: boolean; started_at: string | null }>(
      `SELECT attendance_done, started_at::text FROM session_runs WHERE id = $1`,
      [run1],
    );
    expect(afterAtt.rows[0]!.attendance_done).toBe(true);
    expect(afterAtt.rows[0]!.started_at).not.toBeNull();

    // authorize_run succeeds for STU_A1 submit while open, refuses STU_A2 (absent)
    const okSubAuth = await as(
      db,
      null,
      () => db.query<{ res: unknown }>(`SELECT authorize_run($1, $2, 'lab', 'submit', NULL) AS res`, [STU_A1, q1]),
      'service_role',
    );
    expect(okSubAuth.rows[0]!.res).toBeTruthy();

    const absentSubErr = await err(
      as(
        db,
        null,
        () => db.query(`SELECT authorize_run($1, $2, 'lab', 'submit', NULL)`, [STU_A2, q1]),
        'service_role',
      ),
    );
    expect(absentSubErr).toContain('session_not_open');

    // Viva capped by rubric (10) and refused for absent student
    const vivaOver = await err(
      as(db, FAC_1, () => db.query(`SELECT set_viva($1, $2, NULL, 11)`, [STU_A1, sessId])),
    );
    expect(vivaOver).toContain('viva_exceeds_rubric');

    const vivaAbsent = await err(
      as(db, FAC_1, () => db.query(`SELECT set_viva($1, $2, NULL, 7)`, [STU_A2, sessId])),
    );
    expect(vivaAbsent).toContain('student_absent');

    await as(db, FAC_1, () => db.query(`SELECT set_viva($1, $2, NULL, 8.5)`, [STU_A1, sessId]));

    // send_hint refuses cross-batch student and notifies only chosen batch student
    const crossHint = await err(
      as(db, FAC_1, () => db.query(`SELECT send_hint($1, ARRAY[$2::uuid], 'Check bounds')`, [run1, STU_B1])),
    );
    expect(crossHint).toContain('forbidden');

    await as(db, FAC_1, () =>
      db.query(`SELECT send_hint($1, ARRAY[$2::uuid], 'Check your loop bound i < n')`, [run1, STU_A1]),
    );
    const a1Notifs = await as(db, STU_A1, () => db.query<{ kind: string; body: string }>(`SELECT kind, body FROM notifications`));
    expect(a1Notifs.rows).toEqual([{ kind: 'hint', body: 'Check your loop bound i < n' }]);

    const a2Notifs = await as(db, STU_A2, () => db.query(`SELECT id FROM notifications`));
    expect(a2Notifs.rows).toHaveLength(0);
  });

  it('enforces pre-test 2/2/1 + single attempt + close on attendance, and unlocks post-test only when all hidden tests pass', async () => {
    const db = await freshDb();
    const { courseId, sessId, batchA, q1, q2 } = await setupActiveLab(db);

    const startedPre = await as(db, STU_A1, () =>
      db
        .query<{ res: { attempt_id: string; items: Array<{ id: string; level: string; answer?: number }> } }>(
          `SELECT start_test($1, 'pre') AS res`,
          [sessId],
        )
        .then((r) => r.rows[0]!.res),
    );
    expect(startedPre.items).toHaveLength(5);
    expect(startedPre.items.filter((i) => i.level === 'easy')).toHaveLength(2);
    expect(startedPre.items.filter((i) => i.level === 'medium')).toHaveLength(2);
    expect(startedPre.items.filter((i) => i.level === 'hard')).toHaveLength(1);
    // Answers never leaked
    expect(startedPre.items.every((i) => i.answer === undefined)).toBe(true);

    // Post-test locked until both Q1 & Q2 pass all hidden tests
    const postLockedErr = await err(
      as(db, STU_A1, () => db.query(`SELECT start_test($1, 'post')`, [sessId])),
    );
    expect(postLockedErr).toContain('post_test_locked');

    // STU_A1 submits pre-test and gets scored server-side (answer = 2)
    const answersPayload: Record<string, number> = {};
    startedPre.items.forEach((it, idx) => {
      answersPayload[it.id] = idx < 4 ? 2 : 0; // 4 right, 1 wrong
    });
    const preResult = await as(db, STU_A1, () =>
      db
        .query<{ res: { score: number; total: number } }>(`SELECT submit_test($1, $2::jsonb) AS res`, [
          startedPre.attempt_id,
          JSON.stringify(answersPayload),
        ])
        .then((r) => r.rows[0]!.res),
    );
    expect(preResult).toEqual({ score: 4, total: 5 });

    // Second pre-test attempt refused
    const retryPre = await err(as(db, STU_A1, () => db.query(`SELECT start_test($1, 'pre')`, [sessId])));
    expect(retryPre).toContain('already_submitted');

    // Faculty opens run and marks attendance -> closes pre-test for STU_A2
    const runId = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT start_session_run($1, $2) AS id`, [sessId, batchA]).then((r) => r.rows[0]!.id),
    );
    await as(db, FAC_1, () =>
      db.query(`SELECT save_attendance($1, $2::jsonb)`, [
        runId,
        JSON.stringify([
          { student_id: STU_A1, state: 'present' },
          { student_id: STU_A2, state: 'present' },
        ]),
      ]),
    );

    const latePreErr = await err(as(db, STU_A2, () => db.query(`SELECT start_test($1, 'pre')`, [sessId])));
    expect(latePreErr).toContain('test_closed');

    // Only Q1 passes hidden tests -> post-test still locked
    await db.query(
      `INSERT INTO submissions (institution_id, course_id, session_id, session_run_id, student_id, question_id, context, mode, lang, code, visible_passed, visible_total, hidden_passed, hidden_total, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, 'lab', 'submit', 'c', 'int main(){}', 2, 2, 3, 3, 'accepted')`,
      [INST_ID, courseId, sessId, runId, STU_A1, q1],
    );
    const stillLockedErr = await err(as(db, STU_A1, () => db.query(`SELECT start_test($1, 'post')`, [sessId])));
    expect(stillLockedErr).toContain('post_test_locked');

    // Q2 also passes all 3 hidden tests -> post-test unlocks with 1E/2M/2H!
    await db.query(
      `INSERT INTO submissions (institution_id, course_id, session_id, session_run_id, student_id, question_id, context, mode, lang, code, visible_passed, visible_total, hidden_passed, hidden_total, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, 'lab', 'submit', 'c', 'int main(){}', 2, 2, 3, 3, 'accepted')`,
      [INST_ID, courseId, sessId, runId, STU_A1, q2],
    );
    const startedPost = await as(db, STU_A1, () =>
      db
        .query<{ res: { items: Array<{ level: string }> } }>(`SELECT start_test($1, 'post') AS res`, [sessId])
        .then((r) => r.rows[0]!.res),
    );
    expect(startedPost.items).toHaveLength(5);
    expect(startedPost.items.filter((i) => i.level === 'easy')).toHaveLength(1);
    expect(startedPost.items.filter((i) => i.level === 'medium')).toHaveLength(2);
    expect(startedPost.items.filter((i) => i.level === 'hard')).toHaveLength(2);
  });

  it('prevents students from reading peer drafts, submissions, viva, attendance, attempts, or flags', async () => {
    const db = await freshDb();
    const { courseId, sessId, batchA, q1 } = await setupActiveLab(db);

    await as(db, STU_A1, () => db.query(`SELECT save_draft($1, 'lab', 'c', '// private draft')`, [q1]));
    const runId = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT start_session_run($1, $2) AS id`, [sessId, batchA]).then((r) => r.rows[0]!.id),
    );
    await as(db, FAC_1, () =>
      db.query(`SELECT save_attendance($1, $2::jsonb)`, [
        runId,
        JSON.stringify([{ student_id: STU_A1, state: 'present' }]),
      ]),
    );
    await as(db, FAC_1, () => db.query(`SELECT set_viva($1, $2, NULL, 9)`, [STU_A1, sessId]));
    await as(db, FAC_1, () => db.query(`SELECT flag_student($1, $2, 'slow', 'Needs help')`, [courseId, STU_A1]));

    const a2Drafts = await as(db, STU_A2, () => db.query(`SELECT id FROM drafts`));
    const a2Att = await as(db, STU_A2, () => db.query(`SELECT id FROM attendance`));
    const a2Viva = await as(db, STU_A2, () => db.query(`SELECT id FROM viva`));
    const a1Flags = await as(db, STU_A1, () => db.query(`SELECT id FROM course_flags`));

    expect(a2Drafts.rows).toHaveLength(0);
    expect(a2Att.rows).toHaveLength(0);
    expect(a2Viva.rows).toHaveLength(0);
    expect(a1Flags.rows).toHaveLength(0);

    // Direct notification insert via API user blocked by guard
    const notifSpoof = await err(
      as(db, STU_A1, () =>
        db.query(
          `INSERT INTO notifications (institution_id, user_id, kind, title) VALUES ($1, $2, 'hint', 'Fake')`,
          [INST_ID, STU_A2],
        ),
      ),
    );
    expect(notifSpoof).toMatch(/permission denied|forbidden/i);
  });
});
