/**
 * tests/db/oversight.test.ts
 * DB-layer tests for Phase 6 oversight functions.
 * Uses PGlite + full migration stack.
 */

import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

const INST_ID   = 'aa000000-0000-0000-0000-000000000001';
const SCHOOL_A  = 'aa000000-0000-0000-0000-000000000010';
const SCHOOL_B  = 'aa000000-0000-0000-0000-000000000011';
const DEPT_A    = 'aa000000-0000-0000-0000-000000000020';
const DEPT_B    = 'aa000000-0000-0000-0000-000000000021';

const HOD_A     = 'bb000000-0000-0000-0000-000000000001';
const HOD_B     = 'bb000000-0000-0000-0000-000000000002';
const FAC_ID    = 'bb000000-0000-0000-0000-000000000003';
const COE_ID    = 'bb000000-0000-0000-0000-000000000004';
const VC_ID     = 'bb000000-0000-0000-0000-000000000005';
const DEAN_A    = 'bb000000-0000-0000-0000-000000000007';
const SUPER_ID  = 'bb000000-0000-0000-0000-000000000006';

const COURSE_ID   = 'cc000000-0000-0000-0000-000000000001';
const COURSE_B_ID = 'cc000000-0000-0000-0000-000000000002';
const BATCH_ID    = 'cc000000-0000-0000-0000-000000000010';
const SESSION_ID  = 'cc000000-0000-0000-0000-000000000020';
const RUN_ID      = 'cc000000-0000-0000-0000-000000000025';
const Q1          = 'cc000000-0000-0000-0000-000000000030';
const Q2          = 'cc000000-0000-0000-0000-000000000031';

const S1 = 'dd000000-0000-0000-0000-000000000001';
const S2 = 'dd000000-0000-0000-0000-000000000002';
const S3 = 'dd000000-0000-0000-0000-000000000003';
const S4 = 'dd000000-0000-0000-0000-000000000004';

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();

  await db.exec(`
    INSERT INTO institutions (id, name, email_domain, min_attendance_pct)
    VALUES ('${INST_ID}', 'Test Uni', 'test.edu', 75);

    INSERT INTO schools (id, institution_id, name)
    VALUES ('${SCHOOL_A}', '${INST_ID}', 'School A'),
           ('${SCHOOL_B}', '${INST_ID}', 'School B');

    INSERT INTO departments (id, institution_id, school_id, code, name)
    VALUES ('${DEPT_A}', '${INST_ID}', '${SCHOOL_A}', 'CS', 'Dept A'),
           ('${DEPT_B}', '${INST_ID}', '${SCHOOL_B}', 'ME', 'Dept B');
  `);

  const userDefs = [
    { id: SUPER_ID, email: 'super@elzeo.in', role: 'super_admin', dept: null,   school: null },
    { id: HOD_A,   email: 'hod.a@test.edu',  role: 'hod',         dept: DEPT_A, school: SCHOOL_A },
    { id: HOD_B,   email: 'hod.b@test.edu',  role: 'hod',         dept: DEPT_B, school: SCHOOL_B },
    { id: FAC_ID,  email: 'fac@test.edu',    role: 'faculty',     dept: DEPT_A, school: SCHOOL_A },
    { id: COE_ID,  email: 'coe@test.edu',    role: 'coe',         dept: null,   school: null },
    { id: VC_ID,   email: 'vc@test.edu',     role: 'vc',          dept: null,   school: null },
    { id: DEAN_A,  email: 'dean.a@test.edu', role: 'dean',        dept: null,   school: SCHOOL_A },
  ];

  for (const u of userDefs) {
    await db.exec(`
      INSERT INTO invites (email, institution_id, role, full_name, department_id, school_id)
      VALUES (
        '${u.email}',
        ${u.role === 'super_admin' ? 'NULL' : `'${INST_ID}'`},
        '${u.role}',
        '${u.role} user',
        ${u.dept ? `'${u.dept}'` : 'NULL'},
        ${u.school ? `'${u.school}'` : 'NULL'}
      )
      ON CONFLICT (email) DO NOTHING;

      INSERT INTO auth.users (id, email) VALUES ('${u.id}', '${u.email}')
      ON CONFLICT DO NOTHING;
    `);
  }

  for (let i = 0; i < 4; i++) {
    const sid = [S1, S2, S3, S4][i]!;
    const email = `s${i + 1}@test.edu`;
    await db.exec(`
      INSERT INTO invites (email, institution_id, role, full_name, roll_no)
      VALUES ('${email}', '${INST_ID}', 'student', 'Student ${i + 1}', '230100${i + 1}')
      ON CONFLICT (email) DO NOTHING;

      INSERT INTO auth.users (id, email) VALUES ('${sid}', '${email}')
      ON CONFLICT DO NOTHING;
    `);
  }

  await db.exec(`
    INSERT INTO courses (id, institution_id, department_id, faculty_id, code, title, final_status, plan_status)
    VALUES ('${COURSE_ID}',   '${INST_ID}', '${DEPT_A}', '${FAC_ID}', 'CSL101', 'Prog Lab', 'sent', 'approved'),
           ('${COURSE_B_ID}', '${INST_ID}', '${DEPT_B}', '${FAC_ID}', 'MEL101', 'Mech Lab', 'none', 'draft');

    INSERT INTO batches (id, course_id, institution_id, name, class_code, slot, room)
    VALUES ('${BATCH_ID}', '${COURSE_ID}', '${INST_ID}', 'Batch A', 'CS7Q4K', '9-11', 'Lab 1');

    INSERT INTO sessions (id, course_id, institution_id, n, topic, status)
    VALUES ('${SESSION_ID}', '${COURSE_ID}', '${INST_ID}', 1, 'Hello World', 'conducted');

    INSERT INTO session_runs (id, institution_id, session_id, batch_id, started_at, ended_at, attendance_done)
    VALUES ('${RUN_ID}', '${INST_ID}', '${SESSION_ID}', '${BATCH_ID}', now() - interval '2 hours', now(), true);
  `);

  for (const sid of [S1, S2, S3, S4]) {
    await db.exec(`
      INSERT INTO enrollments (course_id, batch_id, institution_id, student_id)
      VALUES ('${COURSE_ID}', '${BATCH_ID}', '${INST_ID}', '${sid}');
    `);
  }

  // 4 students: S1=present+pass, S2=absent, S3=late (counts as present), S4=present -> 3/4 = 75%
  for (const [sid, state] of [
    [S1, 'present'],
    [S2, 'absent'],
    [S3, 'late'],
    [S4, 'present'],
  ] as const) {
    await db.exec(`
      INSERT INTO attendance (institution_id, session_run_id, student_id, state, marked_by)
      VALUES ('${INST_ID}', '${RUN_ID}', '${sid}', '${state}', '${FAC_ID}');
    `);
  }

  await db.exec(`
    INSERT INTO questions (id, institution_id, course_id, kind, session_id, title, statement, status)
    VALUES ('${Q1}', '${INST_ID}', '${COURSE_ID}', 'lab', '${SESSION_ID}', 'Q1', 'Print 1', 'approved'),
           ('${Q2}', '${INST_ID}', '${COURSE_ID}', 'lab', '${SESSION_ID}', 'Q2', 'Print 2', 'approved');
  `);

  // Only S1 passes both questions (hidden_passed = 3/3) -> completion = 1/4 = 25%
  for (const qid of [Q1, Q2]) {
    await db.exec(`
      INSERT INTO submissions (institution_id, course_id, session_id, session_run_id, student_id, question_id, context, mode, lang, code, visible_passed, visible_total, hidden_passed, hidden_total, marks, verdict)
      VALUES ('${INST_ID}', '${COURSE_ID}', '${SESSION_ID}', '${RUN_ID}', '${S1}', '${qid}', 'lab', 'submit', 'python', 'print(1)', 2, 2, 3, 3, 20, 'AC');
    `);
  }
}, 60_000);

describe('course_stats', () => {
  it('returns correct attendance (75%) and completion (25%) for the fixture', async () => {
    const rows = await as(db, COE_ID, async () => {
      const r = await db.query<{ students: number; attendance_pct: string; completion_pct: string; at_risk: number }>(
        `SELECT students, attendance_pct, completion_pct, at_risk FROM course_stats(ARRAY[$1::uuid])`,
        [COURSE_ID]
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.students).toBe(4);
    expect(Number(rows[0]!.attendance_pct)).toBe(75);
    expect(Number(rows[0]!.completion_pct)).toBe(25);
    expect(rows[0]!.at_risk).toBe(0);
  });

  it('HOD of another department cannot see Dept A courses via RLS', async () => {
    const rows = await as(db, HOD_B, async () => {
      const r = await db.query<{ id: string }>(`SELECT id FROM courses WHERE id = $1`, [COURSE_ID]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('Dean is scoped to their school only via dept_stats', async () => {
    const rows = await as(db, DEAN_A, async () => {
      const r = await db.query<{ department_id: string }>(`SELECT department_id FROM dept_stats()`);
      return r.rows;
    });
    expect(rows.map((r) => r.department_id)).toEqual([DEPT_A]);
  });
});

describe('at_risk_students & live_lab_stats', () => {
  it('returns empty at_risk_students when fewer than 2 sessions conducted', async () => {
    const rows = await as(db, HOD_A, async () => {
      const r = await db.query(`SELECT * FROM at_risk_students(ARRAY[$1::uuid])`, [COURSE_ID]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('returns empty live_lab_stats when no active session', async () => {
    const rows = await as(db, HOD_A, async () => {
      const r = await db.query(`SELECT * FROM live_lab_stats(ARRAY[$1::uuid])`, [COURSE_ID]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe('set_min_attendance & holidays', () => {
  it('CoE and VC can set min attendance, HOD and Faculty cannot', async () => {
    await as(db, COE_ID, async () => { await db.query(`SELECT set_min_attendance(80)`); });
    let r = await db.query<{ min_attendance_pct: number }>(
      `SELECT min_attendance_pct FROM institutions WHERE id = $1`, [INST_ID]
    );
    expect(r.rows[0]!.min_attendance_pct).toBe(80);

    await as(db, VC_ID, async () => { await db.query(`SELECT set_min_attendance(75)`); });
    r = await db.query<{ min_attendance_pct: number }>(
      `SELECT min_attendance_pct FROM institutions WHERE id = $1`, [INST_ID]
    );
    expect(r.rows[0]!.min_attendance_pct).toBe(75);

    expect(await err(as(db, HOD_A, async () => { await db.query(`SELECT set_min_attendance(60)`); }))).toMatch(/forbidden/i);
    expect(await err(as(db, FAC_ID, async () => { await db.query(`SELECT set_min_attendance(60)`); }))).toMatch(/forbidden/i);

    expect(
      await err(as(db, COE_ID, async () => {
        await db.query(`UPDATE institutions SET min_attendance_pct = 90 WHERE id = $1`, [INST_ID]);
      }))
    ).toMatch(/permission denied|use_set_min_attendance/i);
  });

  it('CoE can add and remove a holiday, HOD cannot', async () => {
    const id = await as(db, COE_ID, async () => {
      const r = await db.query<{ add_holiday: string }>(
        `SELECT add_holiday($1::date, $2)`, ['2026-01-26', 'Republic Day']
      );
      return r.rows[0]!.add_holiday;
    });
    expect(id).toBeTruthy();

    await as(db, COE_ID, async () => { await db.query(`SELECT remove_holiday($1::uuid)`, [id]); });
    const check = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM holidays WHERE id = $1`, [id]);
    expect(check.rows[0]!.count).toBe(0);

    expect(
      await err(as(db, HOD_A, async () => {
        await db.query(`SELECT add_holiday($1::date, $2)`, ['2026-08-15', 'Independence Day']);
      }))
    ).toMatch(/forbidden/i);
  });
});

describe('decide_final_marks — oversight role', () => {
  it('CoE can accept hod_approved internals, Faculty cannot', async () => {
    await db.exec(`UPDATE courses SET final_status = 'hod_approved' WHERE id = '${COURSE_ID}'`);

    await as(db, COE_ID, async () => {
      await db.query(`SELECT decide_final_marks($1, true, '')`, [COURSE_ID]);
    });

    const r = await db.query<{ final_status: string }>(
      `SELECT final_status::text FROM courses WHERE id = $1`, [COURSE_ID]
    );
    expect(r.rows[0]!.final_status).toBe('coe_accepted');

    await db.exec(`UPDATE courses SET final_status = 'hod_approved' WHERE id = '${COURSE_ID}'`);
    expect(
      await err(as(db, FAC_ID, async () => {
        await db.query(`SELECT decide_final_marks($1, true, '')`, [COURSE_ID]);
      }))
    ).toMatch(/forbidden/i);
  });
});

describe('RLS isolation', () => {
  it('student cannot see another student attendance', async () => {
    const own = await as(db, S1, async () => {
      const r = await db.query<{ student_id: string }>(
        `SELECT student_id FROM attendance WHERE student_id = $1`, [S1]
      );
      return r.rows;
    });
    expect(own.length).toBeGreaterThan(0);

    const other = await as(db, S1, async () => {
      const r = await db.query<{ student_id: string }>(
        `SELECT student_id FROM attendance WHERE student_id = $1`, [S2]
      );
      return r.rows;
    });
    expect(other).toHaveLength(0);
  });
});
