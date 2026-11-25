/**
 * tests/db/endsem.test.ts
 * DB-layer tests for Phase 7 end-sem practical state machine,
 * authorize_run exam extension, proctor flags, and RLS.
 */

import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const INST_ID   = 'e1000000-0000-0000-0000-000000000001';
const SCHOOL_ID = 'e1000000-0000-0000-0000-000000000010';
const DEPT_ID   = 'e1000000-0000-0000-0000-000000000020';

const HOD_ID = 'e2000000-0000-0000-0000-000000000001';
const FAC_ID = 'e2000000-0000-0000-0000-000000000002';
const S1     = 'e2000000-0000-0000-0000-000000000011';
const S2     = 'e2000000-0000-0000-0000-000000000012';
const S3_ABS = 'e2000000-0000-0000-0000-000000000013';

const COURSE_ID = 'e3000000-0000-0000-0000-000000000001';
const BATCH_ID  = 'e3000000-0000-0000-0000-000000000010';
const CO1_ID    = 'e3000000-0000-0000-0000-000000000021';
const CO2_ID    = 'e3000000-0000-0000-0000-000000000022';

const DEFAULT_RULES = {
  questions_per_student: 2,
  mix: { easy: 15, medium: 15, hard: 10 },
  visible_count: 2,
  hidden_count: 3,
  marks_per_test: 5,
  viva_marks: 10,
  duration_min: 120,
};

let db: PGlite;
let assessmentId: string;
const questionIds: string[] = [];

beforeAll(async () => {
  db = await freshDb();

  await db.exec(`
    INSERT INTO institutions (id, name, email_domain, min_attendance_pct)
    VALUES ('${INST_ID}', 'Test Uni', 'test.edu', 75);

    INSERT INTO schools (id, institution_id, name)
    VALUES ('${SCHOOL_ID}', '${INST_ID}', 'Engineering');

    INSERT INTO departments (id, institution_id, school_id, code, name)
    VALUES ('${DEPT_ID}', '${INST_ID}', '${SCHOOL_ID}', 'CS', 'Computer Science');
  `);

  for (const [id, email, role, roll] of [
    [HOD_ID, 'hod@test.edu', 'hod', null],
    [FAC_ID, 'fac@test.edu', 'faculty', null],
    [S1, 's1@test.edu', 'student', '2301001'],
    [S2, 's2@test.edu', 'student', '2301002'],
    [S3_ABS, 's3@test.edu', 'student', '2301003'],
  ] as const) {
    await db.exec(`
      INSERT INTO invites (email, institution_id, role, full_name, department_id, school_id, roll_no)
      VALUES ('${email}', '${INST_ID}', '${role}', '${email}', '${DEPT_ID}', '${SCHOOL_ID}', ${roll ? `'${roll}'` : 'NULL'});

      INSERT INTO auth.users (id, email) VALUES ('${id}', '${email}');
    `);
  }

  await db.exec(`
    INSERT INTO courses (id, institution_id, department_id, faculty_id, code, title, plan_status)
    VALUES ('${COURSE_ID}', '${INST_ID}', '${DEPT_ID}', '${FAC_ID}', 'CSL101', 'Programming Lab', 'approved');

    INSERT INTO course_outcomes (id, course_id, institution_id, code, statement, btl, unit)
    VALUES ('${CO1_ID}', '${COURSE_ID}', '${INST_ID}', 'CO1', 'Apply basics', 3, 1),
           ('${CO2_ID}', '${COURSE_ID}', '${INST_ID}', 'CO2', 'Design arrays', 4, 2);

    INSERT INTO batches (id, course_id, institution_id, name, class_code, slot, room)
    VALUES ('${BATCH_ID}', '${COURSE_ID}', '${INST_ID}', 'Batch A', 'ENDSEM1', '10-12', 'Lab 1');
  `);

  for (const sid of [S1, S2, S3_ABS]) {
    await db.exec(`
      INSERT INTO enrollments (course_id, batch_id, institution_id, student_id)
      VALUES ('${COURSE_ID}', '${BATCH_ID}', '${INST_ID}', '${sid}');
    `);
  }
}, 60_000);

describe('Phase 7 End-Sem DB & RLS', () => {
  it('validates rules and creates an assessment', async () => {
    const badMix = await err(
      as(db, FAC_ID, async () => {
        await db.query(
          `SELECT create_assessment($1, $2, $3::jsonb, ARRAY[$4::uuid, $5::uuid])`,
          [COURSE_ID, BATCH_ID, JSON.stringify({ ...DEFAULT_RULES, mix: { easy: 10, medium: 10, hard: 10 } }), CO1_ID, CO2_ID],
        );
      }),
    );
    expect(badMix).toMatch(/invalid_rules/);

    assessmentId = await as(db, FAC_ID, async () => {
      const r = await db.query<{ create_assessment: string }>(
        `SELECT create_assessment($1, $2, $3::jsonb, ARRAY[$4::uuid, $5::uuid])`,
        [COURSE_ID, BATCH_ID, JSON.stringify(DEFAULT_RULES), CO1_ID, CO2_ID],
      );
      return r.rows[0]!.create_assessment;
    });
    expect(assessmentId).toBeTruthy();
  });

  it('requires exactly 30 approved valid questions with >=4 per CO, and locks while with HOD', async () => {
    // Seed 40 endsem candidate questions (20 CO1, 20 CO2)
    for (let i = 0; i < 40; i++) {
      const qid = `e4000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
      questionIds.push(qid);
      const coCode = i < 20 ? 'CO1' : 'CO2';
      await db.exec(`
        INSERT INTO questions (id, institution_id, course_id, kind, assessment_id, co_code, difficulty, title, statement, status, valid)
        VALUES ('${qid}', '${INST_ID}', '${COURSE_ID}', 'endsem', '${assessmentId}', '${coCode}', 'medium', 'Endsem Q${i + 1}', 'Solve ${i + 1}', 'candidate', true);

        INSERT INTO test_cases (institution_id, question_id, ord, input, expected, hidden, marks)
        VALUES ('${INST_ID}', '${qid}', 1, '1', '1', false, 5),
               ('${INST_ID}', '${qid}', 2, '2', '2', true, 5);

        INSERT INTO assessment_questions (institution_id, assessment_id, question_id, approved)
        VALUES ('${INST_ID}', '${assessmentId}', '${qid}', false);
      `);
    }

    // Pick only 29 -> refuses need_30_approved
    await as(db, FAC_ID, async () => {
      await db.query(`SELECT pick_assessment_questions($1, $2::uuid[])`, [assessmentId, questionIds.slice(0, 29)]);
    });
    const tooFew = await err(
      as(db, FAC_ID, async () => {
        await db.query(`SELECT send_assessment_to_hod($1)`, [assessmentId]);
      }),
    );
    expect(tooFew).toMatch(/need_30_approved/);

    // Pick 30 balanced (15 CO1 + 15 CO2)
    const balanced30 = [...questionIds.slice(0, 15), ...questionIds.slice(20, 35)];
    expect(balanced30).toHaveLength(30);

    await as(db, FAC_ID, async () => {
      await db.query(`SELECT pick_assessment_questions($1, $2::uuid[])`, [assessmentId, balanced30]);
      await db.query(`SELECT send_assessment_to_hod($1)`, [assessmentId]);
    });

    // Locked while with HOD
    const locked = await err(
      as(db, FAC_ID, async () => {
        await db.query(`SELECT pick_assessment_questions($1, $2::uuid[])`, [assessmentId, balanced30]);
      }),
    );
    expect(locked).toMatch(/not_editable/);

    // Cannot schedule before approval
    const notApp = await err(
      as(db, FAC_ID, async () => {
        await db.query(`SELECT schedule_assessment($1, now() + interval '1 day', 'Lab 1')`, [assessmentId]);
      }),
    );
    expect(notApp).toMatch(/not_approved/);
  });

  it('HOD approves, faculty schedules, attendance gates activation, and present students draw 2 questions', async () => {
    await as(db, HOD_ID, async () => {
      await db.query(`SELECT decide_assessment($1, true, 'Looks balanced')`, [assessmentId]);
    });

    await as(db, FAC_ID, async () => {
      await db.query(`SELECT schedule_assessment($1, now() + interval '1 hour', 'Lab 1')`, [assessmentId]);
    });

    // Cannot activate without attendance
    const needAtt = await err(
      as(db, FAC_ID, async () => {
        await db.query(`SELECT activate_assessment($1)`, [assessmentId]);
      }),
    );
    expect(needAtt).toMatch(/attendance_required/);

    await as(db, FAC_ID, async () => {
      await db.query(
        `SELECT save_exam_attendance($1, $2::jsonb)`,
        [
          assessmentId,
          JSON.stringify([
            { student_id: S1, state: 'present' },
            { student_id: S2, state: 'late' },
            { student_id: S3_ABS, state: 'absent' },
          ]),
        ],
      );
      await db.query(`SELECT activate_assessment($1)`, [assessmentId]);
    });

    // Absent student cannot start
    const absStart = await err(
      as(db, S3_ABS, async () => {
        await db.query(`SELECT start_exam($1)`, [assessmentId]);
      }),
    );
    expect(absStart).toMatch(/not_marked_present/);

    // Present students S1 & S2 start and draw 2 distinct questions
    const p1 = await as(db, S1, async () => {
      const r = await db.query<{ id: string; q_ids: string[] }>(`SELECT id, q_ids FROM start_exam($1)`, [assessmentId]);
      return r.rows[0]!;
    });
    const p2 = await as(db, S2, async () => {
      const r = await db.query<{ id: string; q_ids: string[] }>(`SELECT id, q_ids FROM start_exam($1)`, [assessmentId]);
      return r.rows[0]!;
    });
    expect(p1.q_ids).toHaveLength(2);
    expect(p2.q_ids).toHaveLength(2);

    // authorize_run works for service_role on assigned exam question, blocks unassigned question
    const authOk = await as(
      db,
      null,
      async () => {
        const r = await db.query<{ authorize_run: unknown }>(
          `SELECT authorize_run($1, $2, 'exam'::run_context, 'submit'::run_mode, $3)`,
          [S1, p1.q_ids[0], p1.id],
        );
        return r.rows[0]!.authorize_run;
      },
      'service_role',
    );
    expect(authOk).toBeTruthy();

    // Extra time works
    await as(db, FAC_ID, async () => {
      await db.query(`SELECT grant_extra_time($1, 15)`, [p1.id]);
    });
    const extraCheck = await db.query<{ extra_minutes: number }>(`SELECT extra_minutes FROM exam_papers WHERE id = $1`, [p1.id]);
    expect(extraCheck.rows[0]!.extra_minutes).toBe(15);

    // 3 proctor events flag the paper without terminating
    await as(db, S1, async () => {
      await db.query(`SELECT log_proctor_event($1, 'tab_switch'::proctor_event_type, 1, 'Tab 1', NULL)`, [p1.id]);
      await db.query(`SELECT log_proctor_event($1, 'no_face'::proctor_event_type, 2, 'No face', NULL)`, [p1.id]);
      await db.query(`SELECT log_proctor_event($1, 'fullscreen_exit'::proctor_event_type, 2, 'FS exit', NULL)`, [p1.id]);
    });
    const flagCheck = await db.query<{ flagged: boolean; submitted_at: string | null }>(
      `SELECT flagged, submitted_at FROM exam_papers WHERE id = $1`,
      [p1.id],
    );
    expect(flagCheck.rows[0]!.flagged).toBe(true);
    expect(flagCheck.rows[0]!.submitted_at).toBeNull();

    // End assessment autosubmits open papers
    await as(db, FAC_ID, async () => {
      await db.query(`SELECT end_assessment($1)`, [assessmentId]);
    });
    const subCheck = await db.query<{ submitted_at: string | null }>(
      `SELECT submitted_at FROM exam_papers WHERE id = $1`,
      [p1.id],
    );
    expect(subCheck.rows[0]!.submitted_at).not.toBeNull();

    // Absent student has no exam_paper row (absent, not scored zero)
    const absPaper = await db.query(`SELECT id FROM exam_papers WHERE assessment_id = $1 AND student_id = $2`, [assessmentId, S3_ABS]);
    expect(absPaper.rows).toHaveLength(0);

    // Cannot add to course file with unreviewed flags
    const unrev = await err(
      as(db, FAC_ID, async () => {
        await db.query(`SELECT add_assessment_to_file($1)`, [assessmentId]);
      }),
    );
    expect(unrev).toMatch(/unreviewed_flags/);

    // Review all events, then add to file succeeds
    const evIds = await db.query<{ id: string }>(`SELECT id FROM proctor_events WHERE paper_id = $1`, [p1.id]);
    await as(db, FAC_ID, async () => {
      for (const row of evIds.rows) {
        await db.query(`SELECT review_proctor_event($1)`, [row.id]);
      }
      await db.query(`SELECT add_assessment_to_file($1)`, [assessmentId]);
    });
    const added = await db.query<{ added_to_file: boolean }>(`SELECT added_to_file FROM assessments WHERE id = $1`, [assessmentId]);
    expect(added.rows[0]!.added_to_file).toBe(true);
  });
});
