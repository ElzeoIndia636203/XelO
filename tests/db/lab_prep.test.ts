import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const INST_ID = '10000000-0000-0000-0000-000000000001';
const OTHER_INST_ID = '10000000-0000-0000-0000-000000000099';
const SCHOOL_ID = '20000000-0000-0000-0000-000000000001';
const DEPT_CSE = '30000000-0000-0000-0000-000000000001';

const FAC_1 = '00000000-0000-0000-0000-000000000010';
const FAC_2 = '00000000-0000-0000-0000-000000000011';
const HOD_CSE = '00000000-0000-0000-0000-000000000012';
const STU_1 = '00000000-0000-0000-0000-000000000020';
const STU_2 = '00000000-0000-0000-0000-000000000021';
const STU_OTHER = '00000000-0000-0000-0000-000000000022';

async function setupLabEnv(db: PGlite) {
  await db.exec(`
    INSERT INTO institutions (id, name, email_domain, plan, plan_start, plan_end)
    VALUES
      ('${INST_ID}', 'Sanjivani University', 'sanjivani.edu.in', 'pro', CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date),
      ('${OTHER_INST_ID}', 'Other Inst', 'other.edu.in', 'pro', CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date);

    INSERT INTO schools (id, institution_id, name)
    VALUES ('${SCHOOL_ID}', '${INST_ID}', 'School of Engineering');

    INSERT INTO departments (id, institution_id, school_id, code, name)
    VALUES ('${DEPT_CSE}', '${INST_ID}', '${SCHOOL_ID}', 'CSE', 'Computer Science');

    INSERT INTO invites (email, institution_id, role, full_name, school_id, department_id, roll_no)
    VALUES
      ('fac1@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty One', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('fac2@sanjivani.edu.in', '${INST_ID}', 'faculty', 'Faculty Two', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('hod.cse@sanjivani.edu.in', '${INST_ID}', 'hod', 'HOD CSE', '${SCHOOL_ID}', '${DEPT_CSE}', NULL),
      ('stu1@sanjivani.edu.in', '${INST_ID}', 'student', 'Student One', '${SCHOOL_ID}', '${DEPT_CSE}', '2301001'),
      ('stu2@sanjivani.edu.in', '${INST_ID}', 'student', 'Student Two', '${SCHOOL_ID}', '${DEPT_CSE}', '2301002'),
      ('stu.other@other.edu.in', '${OTHER_INST_ID}', 'student', 'Other Student', NULL, NULL, '9901');

    INSERT INTO auth.users (id, email) VALUES
      ('${FAC_1}', 'fac1@sanjivani.edu.in'),
      ('${FAC_2}', 'fac2@sanjivani.edu.in'),
      ('${HOD_CSE}', 'hod.cse@sanjivani.edu.in'),
      ('${STU_1}', 'stu1@sanjivani.edu.in'),
      ('${STU_2}', 'stu2@sanjivani.edu.in'),
      ('${STU_OTHER}', 'stu.other@other.edu.in');
  `);

  const courseId = await as(db, FAC_1, () =>
    db
      .query<{ id: string }>(
        `SELECT create_course('CSL-101', 'C Programming Lab', '0-0-2-1', 'B.Tech', 'IV', 'SY-B', '2026-27', $1) AS id`,
        [DEPT_CSE],
      )
      .then((r) => r.rows[0]!.id),
  );

  await as(db, FAC_1, async () => {
    const coRes = await db.query<{ id: string }>(
      `INSERT INTO course_outcomes (course_id, institution_id, code, statement, btl, unit)
       VALUES ($1, $2, 'CO1', 'Write C programs using loops and arrays.', 3, 1)
       RETURNING id`,
      [courseId, INST_ID],
    );
    await db.query(
      `INSERT INTO co_po_map (course_id, institution_id, co_id, po_code, level)
       VALUES ($1, $2, $3, 'PO1', 3)`,
      [courseId, INST_ID, coRes.rows[0]!.id],
    );
    await db.query(`SELECT submit_course_plan($1)`, [courseId]);
  });

  await as(db, HOD_CSE, () => db.query(`SELECT decide_course_plan($1, true, 'Approved')`, [courseId]));

  await as(db, FAC_1, () =>
    db.query(`SELECT import_roster($1, $2::jsonb)`, [
      courseId,
      JSON.stringify([
        { roll_no: '2301001', full_name: 'Student One', email: 'stu1@sanjivani.edu.in' },
        { roll_no: '2301002', full_name: 'Student Two', email: 'stu2@sanjivani.edu.in' },
      ]),
    ]),
  );

  await as(db, FAC_1, () =>
    db.query(`SELECT save_session_plan($1, ARRAY['Arrays and sorting'], ARRAY['2027-01-06']::date[])`, [courseId]),
  );

  const sessId = await db
    .query<{ id: string }>(`SELECT id FROM sessions WHERE course_id = $1 AND n = 1`, [courseId])
    .then((r) => r.rows[0]!.id);

  return { courseId, sessId };
}

async function seedFullBank(db: PGlite, sessionId: string, bank: 'pre' | 'post', prefix: string) {
  const levels: Array<'easy' | 'medium' | 'hard'> = ['easy', 'medium', 'hard'];
  const items: Array<{ bank: string; level: string; stem: string; options: string[]; answer: number }> = [];
  for (const level of levels) {
    for (let i = 1; i <= 15; i++) {
      items.push({
        bank,
        level,
        stem:
          bank === 'pre'
            ? `${prefix} readiness check concept ${level} case ${i} before lab`
            : `${prefix} runtime debugging complexity ${level} scenario ${i} after pass`,
        options: ['Alpha', 'Beta', 'Gamma', 'Delta'],
        answer: 1,
      });
    }
  }
  await as(db, FAC_1, () =>
    db.query(`SELECT import_bank_items($1, $2::jsonb)`, [sessionId, JSON.stringify(items)]),
  );
}

describe('Phase 3 Lab Prep DB & RLS', () => {
  it('activates a session only when 2 valid questions and both 15/15/15 banks are approved, and refuses overlap or invalid candidates', async () => {
    const db = await freshDb();
    const { courseId, sessId } = await setupLabEnv(db);

    const samplePayload = (title: string) => ({
      title,
      statement: 'Read an integer N and print 2*N.',
      input_spec: 'Single integer N',
      output_spec: '2*N',
      constraints: '0 <= N <= 1000',
      difficulty: 'medium',
      co_code: 'CO1',
      visible_tests: [
        { input: '2\n', expected: '4\n' },
        { input: '5\n', expected: '10\n' },
      ],
      hidden_tests: [
        { input: '0\n', expected: '0\n' },
        { input: '10\n', expected: '20\n' },
        { input: '-3\n', expected: '-6\n' },
      ],
      references: { c: '#include <stdio.h>\nint main(){int n;scanf("%d",&n);printf("%d\\n",2*n);return 0;}' },
    });

    const q1 = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT save_own_question($1, $2::jsonb) AS id`, [sessId, JSON.stringify(samplePayload('Double value'))]).then((r) => r.rows[0]!.id),
    );
    const q2 = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT save_own_question($1, $2::jsonb) AS id`, [sessId, JSON.stringify(samplePayload('Triple value'))]).then((r) => r.rows[0]!.id),
    );
    const qBad = await as(db, FAC_1, () =>
      db.query<{ id: string }>(`SELECT save_own_question($1, $2::jsonb) AS id`, [sessId, JSON.stringify(samplePayload('Broken candidate'))]).then((r) => r.rows[0]!.id),
    );

    // Guard blocks direct status/valid edits from API users
    const guardMsg = await err(
      as(db, FAC_1, () => db.query(`UPDATE questions SET valid = true, status = 'approved' WHERE id = $1`, [q1])),
    );
    expect(guardMsg).toContain('forbidden');

    // Cannot pick unvalidated or invalid questions
    await db.query(`UPDATE questions SET valid = false, validation_note = 'Wrong answer case 4' WHERE id = $1`, [qBad]);
    const unvalidatedErr = await err(
      as(db, FAC_1, () => db.query(`SELECT pick_session_questions($1, $2, $3)`, [sessId, q1, qBad])),
    );
    expect(unvalidatedErr).toContain('question_not_valid');

    // Mark q1 and q2 valid as service_role (simulating validate-question edge function)
    await db.query(`UPDATE questions SET valid = true, validation_note = 'Passed all 5 cases' WHERE id IN ($1, $2)`, [q1, q2]);

    const afterPick = await as(db, FAC_1, () =>
      db.query<{ s: string }>(`SELECT pick_session_questions($1, $2, $3)::text AS s`, [sessId, q1, q2]).then((r) => r.rows[0]!.s),
    );
    expect(afterPick).toBe('draft');

    // Incomplete bank refused
    await as(db, FAC_1, () =>
      db.query(
        `INSERT INTO bank_items (institution_id, session_id, bank, level, stem, options, answer)
         VALUES ($1, $2, 'pre', 'easy', 'Only one question', '["A","B"]'::jsonb, 0)`,
        [INST_ID, sessId],
      ),
    );
    const incompleteMsg = await err(
      as(db, FAC_1, () => db.query(`SELECT approve_bank($1, 'pre')`, [sessId])),
    );
    expect(incompleteMsg).toContain('bank_incomplete');

    // Load 45 pre items and approve
    await seedFullBank(db, sessId, 'pre', 'PreCheck');
    const afterPre = await as(db, FAC_1, () =>
      db.query<{ s: string }>(`SELECT approve_bank($1, 'pre')::text AS s`, [sessId]).then((r) => r.rows[0]!.s),
    );
    expect(afterPre).toBe('draft');

    // Load 45 post items with one near-duplicate stem -> refused with bank_overlap
    await seedFullBank(db, sessId, 'post', 'PostVerify');
    await as(db, FAC_1, () =>
      db.query(
        `UPDATE bank_items SET stem = 'PreCheck readiness check concept easy case 1 before lab!'
         WHERE id = (SELECT id FROM bank_items WHERE session_id = $1 AND bank = 'post' LIMIT 1)`,
        [sessId],
      ),
    );
    const overlapMsg = await err(
      as(db, FAC_1, () => db.query(`SELECT approve_bank($1, 'post')`, [sessId])),
    );
    expect(overlapMsg).toContain('bank_overlap');

    // Fix colliding stem and approve -> session activates!
    await as(db, FAC_1, () =>
      db.query(
        `UPDATE bank_items SET stem = 'Distinct evaluation question for final verification check'
         WHERE session_id = $1 AND bank = 'post' AND stem LIKE 'PreCheck%'`,
        [sessId],
      ),
    );
    const afterPost = await as(db, FAC_1, () =>
      db.query<{ s: string }>(`SELECT approve_bank($1, 'post')::text AS s`, [sessId]).then((r) => r.rows[0]!.s),
    );
    expect(afterPost).toBe('active');

    const sessRow = await db.query<{ status: string }>(`SELECT status::text FROM sessions WHERE id = $1`, [sessId]);
    expect(sessRow.rows[0]!.status).toBe('active');

    // Deleting a bank item drops active session back to draft and unapproves bank
    const oneItem = await db
      .query<{ id: string }>(`SELECT id FROM bank_items WHERE session_id = $1 AND bank = 'post' LIMIT 1`, [sessId])
      .then((r) => r.rows[0]!.id);
    await as(db, FAC_1, () => db.query(`SELECT delete_bank_item($1)`, [oneItem]));
    const afterDel = await db.query<{ status: string }>(`SELECT status::text FROM sessions WHERE id = $1`, [sessId]);
    expect(afterDel.rows[0]!.status).toBe('draft');
    expect(courseId).toBeTruthy();
  });

  it('prevents students from reading hidden test cases, reference solutions, bank items, unpicked questions, or peers submissions', async () => {
    const db = await freshDb();
    const { courseId, sessId } = await setupLabEnv(db);

    const makeQ = async (title: string, pick: boolean) => {
      const qid = await as(db, FAC_1, () =>
        db
          .query<{ id: string }>(
            `SELECT save_own_question($1, $2::jsonb) AS id`,
            [
              sessId,
              JSON.stringify({
                title,
                statement: 'Sum two integers',
                difficulty: 'easy',
                co_code: 'CO1',
                visible_tests: [
                  { input: '1 2', expected: '3' },
                  { input: '4 5', expected: '9' },
                ],
                hidden_tests: [
                  { input: 'SECRET_1', expected: '100' },
                  { input: 'SECRET_2', expected: '200' },
                  { input: 'SECRET_3', expected: '300' },
                ],
                references: { c: 'int main(){return 0;}' },
              }),
            ],
          )
          .then((r) => r.rows[0]!.id),
      );
      if (pick) {
        await db.query(`UPDATE questions SET valid = true WHERE id = $1`, [qid]);
      }
      return qid;
    };

    const q1 = await makeQ('Visible Q1', true);
    const q2 = await makeQ('Visible Q2', true);
    const qUnpicked = await makeQ('Unpicked Draft Q', false);

    // Student cannot see questions BEFORE session becomes active
    const beforeActive = await as(db, STU_1, () => db.query(`SELECT id FROM questions`));
    expect(beforeActive.rows.length).toBe(0);

    await as(db, FAC_1, () => db.query(`SELECT pick_session_questions($1, $2, $3)`, [sessId, q1, q2]));
    await seedFullBank(db, sessId, 'pre', 'PreAlpha');
    await seedFullBank(db, sessId, 'post', 'PostBeta');
    await as(db, FAC_1, () => db.query(`SELECT approve_bank($1, 'pre')`, [sessId]));
    await as(db, FAC_1, () => db.query(`SELECT approve_bank($1, 'post')`, [sessId]));

    // Now session is active: student sees ONLY the 2 picked questions and NEVER unpicked
    const stuQs = await as(db, STU_1, () => db.query<{ id: string }>(`SELECT id FROM questions`));
    expect(stuQs.rows.map((r) => r.id).sort()).toEqual([q1, q2].sort());
    expect(stuQs.rows.some((r) => r.id === qUnpicked)).toBe(false);

    // Student sees ONLY hidden = false test cases (2 per picked question = 4 total)
    const stuTcs = await as(db, STU_1, () =>
      db.query<{ hidden: boolean; input: string }>(`SELECT hidden, input FROM test_cases`),
    );
    expect(stuTcs.rows.length).toBe(4);
    expect(stuTcs.rows.every((t) => t.hidden === false && !t.input.includes('SECRET'))).toBe(true);

    // Hidden test counts safe RPC works
    const counts = await as(db, STU_1, () =>
      db.query<{ visible_count: number; hidden_count: number }>(
        `SELECT visible_count, hidden_count FROM hidden_test_counts(ARRAY[$1::uuid])`,
        [q1],
      ),
    );
    expect(counts.rows[0]).toEqual({ visible_count: 2, hidden_count: 3 });

    // Student gets 0 rows on reference_solutions and bank_items
    const stuRefs = await as(db, STU_1, () => db.query(`SELECT id FROM reference_solutions`));
    expect(stuRefs.rows.length).toBe(0);
    const stuBanks = await as(db, STU_1, () => db.query(`SELECT id FROM bank_items`));
    expect(stuBanks.rows.length).toBe(0);

    // Student cannot read another student's submissions or other institution data
    await db.query(
      `INSERT INTO submissions (institution_id, course_id, session_id, student_id, question_id, context, mode, lang, code, visible_passed, visible_total, verdict)
       VALUES ($1, $2, $3, $4, $5, 'lab', 'run', 'c', 'int main(){}', 2, 2, 'accepted')`,
      [INST_ID, courseId, sessId, STU_2, q1],
    );
    const stu1Subs = await as(db, STU_1, () => db.query(`SELECT id FROM submissions`));
    expect(stu1Subs.rows.length).toBe(0);
    const stu2Subs = await as(db, STU_2, () => db.query(`SELECT id FROM submissions`));
    expect(stu2Subs.rows.length).toBe(1);

    const otherInstQs = await as(db, STU_OTHER, () => db.query(`SELECT id FROM questions`));
    expect(otherInstQs.rows.length).toBe(0);
  });

  it('restricts authorize_run to service_role and blocks student/wrong-faculty AI usage and daily caps', async () => {
    const db = await freshDb();
    const { courseId, sessId } = await setupLabEnv(db);

    const q1 = await as(db, FAC_1, () =>
      db
        .query<{ id: string }>(
          `SELECT save_own_question($1, $2::jsonb) AS id`,
          [
            sessId,
            JSON.stringify({
              title: 'Auth Run Test',
              statement: 'Print ok',
              difficulty: 'easy',
              co_code: 'CO1',
              visible_tests: [
                { input: '', expected: 'ok' },
                { input: '1', expected: 'ok' },
              ],
              hidden_tests: [
                { input: '2', expected: 'ok' },
                { input: '3', expected: 'ok' },
                { input: '4', expected: 'ok' },
              ],
              references: { c: 'int main(){return 0;}' },
            }),
          ],
        )
        .then((r) => r.rows[0]!.id),
    );
    await db.query(`UPDATE questions SET valid = true WHERE id = $1`, [q1]);

    // Authenticated user cannot call authorize_run directly
    const authRunErr = await err(
      as(db, STU_1, () => db.query(`SELECT authorize_run($1, $2, 'lab', 'run', NULL)`, [STU_1, q1])),
    );
    expect(authRunErr.toLowerCase()).toContain('permission denied');

    // service_role authorizes faculty preview run cleanly with visible + hidden tests
    const facAuth = await as(
      db,
      null,
      () => db.query<{ res: { hidden_tests: unknown[]; visible_tests: unknown[] } }>(`SELECT authorize_run($1, $2, 'lab', 'run', NULL) AS res`, [FAC_1, q1]),
      'service_role',
    );
    expect(facAuth.rows[0]!.res.visible_tests.length).toBe(2);
    expect(facAuth.rows[0]!.res.hidden_tests.length).toBe(3);

    // Wrong faculty cannot touch another faculty's session
    const wrongFacPick = await err(
      as(db, FAC_2, () => db.query(`SELECT approve_bank($1, 'pre')`, [sessId])),
    );
    expect(wrongFacPick).toContain('forbidden');

    // Students cannot consume AI credits
    const stuAi = await err(
      as(db, STU_1, () => db.query(`SELECT consume_ai_credit('lab_candidates', $1)`, [courseId])),
    );
    expect(stuAi).toContain('forbidden');

    // Daily cap (Pro = 5) is enforced on FAC_1
    for (let i = 0; i < 5; i++) {
      await as(db, FAC_1, () => db.query(`SELECT consume_ai_credit('lab_candidates', $1)`, [courseId]));
    }
    const capErr = await err(
      as(db, FAC_1, () => db.query(`SELECT consume_ai_credit('bank', $1)`, [courseId])),
    );
    expect(capErr).toContain('daily_cap');
  });
});
