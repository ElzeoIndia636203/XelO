import { describe, expect, it } from 'vitest';
import { computeReport, type CourseReportDataset } from '../../src/lib/api/report';

function baseDataset(): CourseReportDataset {
  return {
    course: {
      id: 'c1',
      institution_id: 'i1',
      department_id: 'd1',
      faculty_id: 'f1',
      code: 'CSL-101',
      title: 'Programming in C Lab',
      ltpc: '0-0-2-1',
      programme: 'B.Tech',
      semester: 'IV',
      section: 'SY-B',
      academic_year: '2026-27',
      plan_status: 'approved',
      plan_remark: null,
      rubric: { att: 10, pre: 5, post: 5, vis: 10, hid: 10, viva: 10 },
      allowed_langs: ['c'],
      attainment_target: 60,
      final_status: 'none',
      created_at: '2026-11-01T00:00:00Z',
    },
    institution: {
      name: 'Sanjivani University',
      min_attendance_pct: 75,
      attainment_threshold_pct: 60,
      level_1_pct: 60,
      level_2_pct: 70,
      level_3_pct: 80,
      internal_weight: 0.4,
      endsem_weight: 0.6,
    },
    outcomes: [
      { id: 'co1', course_id: 'c1', institution_id: 'i1', code: 'CO1', statement: 'Apply I/O', btl: 3, unit: 1 },
      { id: 'co2', course_id: 'c1', institution_id: 'i1', code: 'CO2', statement: 'Arrays', btl: 4, unit: 2 },
    ],
    coPoMap: [
      { id: 'm1', course_id: 'c1', institution_id: 'i1', co_id: 'co1', po_code: 'PO1', level: 3 },
      { id: 'm2', course_id: 'c1', institution_id: 'i1', co_id: 'co2', po_code: 'PO2', level: 2 },
    ],
    batches: [
      { id: 'b1', course_id: 'c1', institution_id: 'i1', name: 'Batch A', class_code: 'AAAA11', slot: 'Wed', room: 'L1', staff: 'F1', created_at: '' },
    ],
    enrollments: [
      { id: 'e1', course_id: 'c1', batch_id: 'b1', institution_id: 'i1', student_id: 's1', created_at: '' },
      { id: 'e2', course_id: 'c1', batch_id: 'b1', institution_id: 'i1', student_id: 's2', created_at: '' },
      { id: 'e3', course_id: 'c1', batch_id: 'b1', institution_id: 'i1', student_id: 's3', created_at: '' },
    ],
    students: [
      { id: 's1', institution_id: 'i1', email: 's1@edu', full_name: 'Aarav', role: 'student', school_id: null, department_id: null, roll_no: '2301001', active: true, plan_override: null, calendar_token: 't1', created_at: '' },
      { id: 's2', institution_id: 'i1', email: 's2@edu', full_name: 'Diya', role: 'student', school_id: null, department_id: null, roll_no: '2301002', active: true, plan_override: null, calendar_token: 't2', created_at: '' },
      { id: 's3', institution_id: 'i1', email: 's3@edu', full_name: 'Rohan', role: 'student', school_id: null, department_id: null, roll_no: '2301003', active: true, plan_override: null, calendar_token: 't3', created_at: '' },
    ],
    sessions: [
      { id: 'sess1', course_id: 'c1', institution_id: 'i1', n: 1, topic: 'I/O', co_id: 'co1', btl: 3, scheduled_date: '2026-11-20', status: 'conducted', pre_open: null, pre_close: null, post_close: null, created_at: '' },
      { id: 'sess2', course_id: 'c1', institution_id: 'i1', n: 2, topic: 'Arrays', co_id: 'co2', btl: 4, scheduled_date: '2026-11-27', status: 'active', pre_open: null, pre_close: null, post_close: null, created_at: '' },
    ],
    sessionRuns: [
      { id: 'r1', institution_id: 'i1', session_id: 'sess1', batch_id: 'b1', started_at: '2026-11-20T09:00:00Z', ended_at: '2026-11-20T11:00:00Z', attendance_done: true, post_close: null, remark: 'Smooth', created_at: '' },
    ],
    attendance: [
      { id: 'a1', institution_id: 'i1', session_run_id: 'r1', assessment_id: null, student_id: 's1', state: 'present', marked_by: 'f1', at: '' },
      { id: 'a2', institution_id: 'i1', session_run_id: 'r1', assessment_id: null, student_id: 's2', state: 'late', marked_by: 'f1', at: '' },
      { id: 'a3', institution_id: 'i1', session_run_id: 'r1', assessment_id: null, student_id: 's3', state: 'absent', marked_by: 'f1', at: '' },
    ],
    attempts: [
      { id: 't1', institution_id: 'i1', session_id: 'sess1', student_id: 's1', bank: 'pre', item_ids: [], answers: {}, score: 5, started_at: '', submitted_at: '2026-11-20T08:00:00Z' },
      { id: 't2', institution_id: 'i1', session_id: 'sess1', student_id: 's1', bank: 'post', item_ids: [], answers: {}, score: 5, started_at: '', submitted_at: '2026-11-20T12:00:00Z' },
      { id: 't3', institution_id: 'i1', session_id: 'sess1', student_id: 's2', bank: 'pre', item_ids: [], answers: {}, score: 3, started_at: '', submitted_at: '2026-11-20T08:00:00Z' },
    ],
    sessionQuestions: [
      { id: 'sq1', institution_id: 'i1', session_id: 'sess1', slot: 1, question_id: 'q1' },
      { id: 'sq2', institution_id: 'i1', session_id: 'sess1', slot: 2, question_id: 'q2' },
    ],
    questions: [
      { id: 'q1', institution_id: 'i1', course_id: 'c1', kind: 'lab', session_id: 'sess1', assessment_id: null, co_code: 'CO1', difficulty: 'easy', title: 'Q1', statement: '', input_spec: '', output_spec: '', constraints: '', starter_code: {}, status: 'approved', source: 'ai', valid: true, validation_note: null, created_by: 'f1', created_at: '' },
      { id: 'q2', institution_id: 'i1', course_id: 'c1', kind: 'lab', session_id: 'sess1', assessment_id: null, co_code: 'CO1', difficulty: 'medium', title: 'Q2', statement: '', input_spec: '', output_spec: '', constraints: '', starter_code: {}, status: 'approved', source: 'ai', valid: true, validation_note: null, created_by: 'f1', created_at: '' },
    ],
    submissions: [
      { id: 'sub1', institution_id: 'i1', course_id: 'c1', session_id: 'sess1', session_run_id: 'r1', exam_paper_id: null, student_id: 's1', question_id: 'q1', context: 'lab', mode: 'submit', lang: 'c', code: 'int main(){}', visible_passed: 2, visible_total: 2, hidden_passed: 3, hidden_total: 3, marks: 0, verdict: 'accepted', runtime_ms: 10, memory_kb: 1000, created_at: '2026-11-20T10:00:00Z' },
      { id: 'sub2', institution_id: 'i1', course_id: 'c1', session_id: 'sess1', session_run_id: 'r1', exam_paper_id: null, student_id: 's1', question_id: 'q2', context: 'lab', mode: 'submit', lang: 'c', code: 'int main(){}', visible_passed: 2, visible_total: 2, hidden_passed: 3, hidden_total: 3, marks: 0, verdict: 'accepted', runtime_ms: 10, memory_kb: 1000, created_at: '2026-11-20T10:20:00Z' },
      { id: 'sub3', institution_id: 'i1', course_id: 'c1', session_id: 'sess1', session_run_id: 'r1', exam_paper_id: null, student_id: 's2', question_id: 'q1', context: 'lab', mode: 'run', lang: 'c', code: 'int main(){}', visible_passed: 2, visible_total: 2, hidden_passed: 0, hidden_total: 3, marks: 0, verdict: 'visible_passed', runtime_ms: 12, memory_kb: 1000, created_at: '2026-11-20T10:05:00Z' },
    ],
    vivas: [
      { id: 'v1', institution_id: 'i1', session_id: 'sess1', assessment_id: null, student_id: 's1', marks: 10, examiner_id: 'f1', updated_at: '' },
      { id: 'v2', institution_id: 'i1', session_id: 'sess1', assessment_id: null, student_id: 's2', marks: 6, examiner_id: 'f1', updated_at: '' },
      // Absent student viva ignored by sessionMarks
      { id: 'v3', institution_id: 'i1', session_id: 'sess1', assessment_id: null, student_id: 's3', marks: 9, examiner_id: 'f1', updated_at: '' },
    ],
    notes: null,
    flags: [],
    approvals: [],
  };
}

describe('computeReport', () => {
  it('handles partial conducted sessions, present/late/absent attendance, 14 sections, and slow/fast learners', () => {
    const rep = computeReport(baseDataset());

    // Only sess1 is conducted out of 2 sessions
    expect(rep.conductedSessions).toHaveLength(1);
    expect(rep.courseFileSections).toHaveLength(14);
    expect(rep.courseFileSections[6]!.status).toBe('To date (S1–S1)');
    expect(rep.hasEndsem).toBe(false);

    const aarav = rep.rows.find((r) => r.student.id === 's1')!;
    const diya = rep.rows.find((r) => r.student.id === 's2')!;
    const rohan = rep.rows.find((r) => r.student.id === 's3')!;

    expect(aarav.internalPct).toBe(100);
    expect(aarav.attendancePct).toBe(100);

    // Late gets 5 att + 3 pre + 0 post + 5 vis (2/4 * 10) + 0 hid + 6 viva = 19 / 50 -> 38/100
    expect(diya.attendancePct).toBe(100);
    expect(diya.internalPct).toBe(38);

    // Absent gets 0 viva and 0 attendance -> 0/100
    expect(rohan.internalPct).toBe(0);
    expect(rohan.attendancePct).toBe(0);

    expect(rep.fastLearners.map((x) => x.studentId)).toEqual(['s1']);
    expect(rep.slowLearners.map((x) => x.studentId)).toEqual(['s3', 's2']);
  });

  it('merges end-sem marks with configured 40/60 weights when endsemPctByStudent is supplied', () => {
    const ds = baseDataset();
    ds.endsemPctByStudent = new Map([
      ['s1', 80], // 0.4*100 + 0.6*80 = 88
      ['s2', 50], // 0.4*38 + 0.6*50 = 15.2 + 30 = 45.2
      ['s3', 20], // 0.4*0 + 0.6*20 = 12
    ]);
    ds.endsemCoPctByStudent = new Map([
      ['s1', new Map([['co1', 80], ['co2', 80]])],
      ['s2', new Map([['co1', 50], ['co2', 50]])],
      ['s3', new Map([['co1', 20], ['co2', 20]])],
    ]);

    const rep = computeReport(ds);
    expect(rep.hasEndsem).toBe(true);
    expect(rep.rows.find((r) => r.student.id === 's1')!.overallPct).toBe(88);
    expect(rep.rows.find((r) => r.student.id === 's2')!.overallPct).toBe(45.2);
    expect(rep.rows.find((r) => r.student.id === 's3')!.overallPct).toBe(12);
    expect(rep.courseFileSections[12]!.ready).toBe(true);
  });
});
