import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../../lib/errors';
import {
  assistPickBest30,
  DEFAULT_ASSESSMENT_RULES,
  paperMarksBreakdown,
  validateAssessmentRules,
  type AssessmentRules,
} from '../../../lib/logic/endsem';
import { supabase } from '../../../lib/supabase';
import type { Batch, Course, CourseOutcome, Enrollment, Profile } from '../../../lib/types';

type StageKey = 'rules' | 'generate' | 'hod_pending' | 'scheduled' | 'live' | 'marks';

const STAGE_ORDER: { key: StageKey; code: string; label: string }[] = [
  { key: 'rules', code: 'E1', label: 'Rules' },
  { key: 'generate', code: 'E2', label: 'Generate & approve 30' },
  { key: 'hod_pending', code: 'E3', label: 'HOD approval' },
  { key: 'scheduled', code: 'E4', label: 'Schedule' },
  { key: 'live', code: 'E5', label: 'Attendance & conduct' },
  { key: 'marks', code: 'E6', label: 'Marks & attainment' },
];

interface AssessmentRow {
  id: string;
  course_id: string;
  batch_id: string;
  rules: AssessmentRules;
  cos: string[];
  rules_locked: boolean;
  stage: StageKey;
  hod_status: string;
  hod_remark: string | null;
  scheduled_at: string | null;
  room: string;
  attendance_done: boolean;
  activated_at: string | null;
  ended_at: string | null;
  added_to_file: boolean;
}

interface CandidateRow {
  id: string;
  question_id: string;
  approved: boolean;
  questions: {
    id: string;
    title: string;
    co_code: string;
    difficulty: 'easy' | 'medium' | 'hard';
    valid: boolean | null;
  } | null;
}

interface ExamPaperRow {
  id: string;
  student_id: string;
  q_ids: string[];
  started_at: string;
  deadline: string;
  extra_minutes: number;
  submitted_at: string | null;
  flagged: boolean;
}

interface ProctorEventRow {
  id: string;
  paper_id: string;
  event_type: string;
  severity: number;
  detail: string;
  at: string;
  reviewed_at: string | null;
}

interface ExamAttendanceRow {
  student_id: string;
  state: 'present' | 'late' | 'absent';
}

interface ExamSubmissionRow {
  student_id: string;
  question_id: string;
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  marks: number;
}

interface ExamVivaRow {
  student_id: string;
  marks: number;
}

export function AssessmentsStep({
  course,
  outcomes,
  batches,
  enrollments,
  studentProfiles,
  onNotify,
  onRefresh,
}: {
  course: Course;
  outcomes: CourseOutcome[];
  batches: Batch[];
  enrollments: Enrollment[];
  studentProfiles: Profile[];
  onNotify: (text: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const [batchId, setBatchId] = useState(batches[0]?.id ?? '');
  const [assessment, setAssessment] = useState<AssessmentRow | null>(null);
  const [viewStage, setViewStage] = useState<StageKey>('rules');
  const [rules, setRules] = useState<AssessmentRules>(DEFAULT_ASSESSMENT_RULES);
  const [selectedCos, setSelectedCos] = useState<string[]>(() => outcomes.map((o) => o.id));
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [schedDate, setSchedDate] = useState('2026-12-10T10:00');
  const [schedRoom, setSchedRoom] = useState('Lab 1');
  const [attMap, setAttMap] = useState<Record<string, 'present' | 'late' | 'absent'>>({});
  const [papers, setPapers] = useState<ExamPaperRow[]>([]);
  const [events, setEvents] = useState<ProctorEventRow[]>([]);
  const [subs, setSubs] = useState<ExamSubmissionRow[]>([]);
  const [vivaMap, setVivaMap] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const batchStudents = enrollments
    .filter((e) => e.batch_id === batchId)
    .map((e) => studentProfiles.find((p) => p.id === e.student_id))
    .filter((p): p is Profile => Boolean(p));

  const loadAssessment = useCallback(async () => {
    if (!batchId) return;
    const { data, error } = await supabase
      .from('assessments')
      .select('*')
      .eq('course_id', course.id)
      .eq('batch_id', batchId)
      .maybeSingle();
    if (error) {
      onNotify(errorMessage(error), false);
      return;
    }
    const row = (data as AssessmentRow | null) ?? null;
    setAssessment(row);
    if (row) {
      setRules(row.rules ?? DEFAULT_ASSESSMENT_RULES);
      setSelectedCos(row.cos?.length ? row.cos : outcomes.map((o) => o.id));
      setViewStage(row.stage);
      if (row.room) setSchedRoom(row.room);

      const [{ data: cands }, { data: paps }, { data: attRows }, { data: subRows }, { data: vivaRows }] =
        await Promise.all([
          supabase
            .from('assessment_questions')
            .select('id, question_id, approved, questions(id, title, co_code, difficulty, valid)')
            .eq('assessment_id', row.id),
          supabase.from('exam_papers').select('*').eq('assessment_id', row.id),
          supabase.from('attendance').select('student_id, state').eq('assessment_id', row.id),
          supabase
            .from('submissions')
            .select('student_id, question_id, visible_passed, visible_total, hidden_passed, hidden_total, marks')
            .eq('course_id', course.id)
            .eq('context', 'exam')
            .eq('mode', 'submit'),
          supabase.from('viva').select('student_id, marks').eq('assessment_id', row.id),
        ]);

      setCandidates((cands ?? []) as unknown as CandidateRow[]);
      const paperList = (paps ?? []) as ExamPaperRow[];
      setPapers(paperList);

      if (paperList.length > 0) {
        const { data: evRows } = await supabase
          .from('proctor_events')
          .select('*')
          .in('paper_id', paperList.map((p) => p.id))
          .order('at', { ascending: false });
        setEvents((evRows ?? []) as ProctorEventRow[]);
      } else {
        setEvents([]);
      }

      const nextAtt: Record<string, 'present' | 'late' | 'absent'> = {};
      for (const a of (attRows ?? []) as ExamAttendanceRow[]) {
        nextAtt[a.student_id] = a.state;
      }
      setAttMap(nextAtt);
      setSubs((subRows ?? []) as ExamSubmissionRow[]);

      const nextViva: Record<string, number> = {};
      for (const v of (vivaRows ?? []) as ExamVivaRow[]) {
        nextViva[v.student_id] = Number(v.marks);
      }
      setVivaMap(nextViva);
    } else {
      setViewStage('rules');
      setCandidates([]);
      setPapers([]);
      setEvents([]);
    }
  }, [batchId, course.id, onNotify, outcomes]);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadAssessment();
    }, 0);
    return () => clearTimeout(id);
  }, [loadAssessment]);

  // Live proctor panel polls every 5s while live
  useEffect(() => {
    if (assessment?.stage !== 'live') return;
    const timer = setInterval(() => {
      void loadAssessment();
    }, 5_000);
    return () => clearInterval(timer);
  }, [assessment?.stage, loadAssessment]);

  const currentStageIdx = assessment
    ? STAGE_ORDER.findIndex((s) => s.key === assessment.stage)
    : 0;

  const breakdown = paperMarksBreakdown(rules);
  const ruleErrs = validateAssessmentRules(rules, selectedCos);

  async function handleSaveRules() {
    if (ruleErrs.length > 0) {
      onNotify(ruleErrs[0]!, false);
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('create_assessment', {
      p_course_id: course.id,
      p_batch_id: batchId,
      p_rules: rules,
      p_cos: selectedCos,
    });
    setBusy(false);
    if (error) {
      onNotify(errorMessage(error), false);
    } else {
      onNotify('Assessment rules saved.', true);
      await loadAssessment();
    }
  }

  async function handleGenerate40() {
    let targetId = assessment?.id;
    if (!targetId) {
      const { data: createdId, error: ce } = await supabase.rpc('create_assessment', {
        p_course_id: course.id,
        p_batch_id: batchId,
        p_rules: rules,
        p_cos: selectedCos,
      });
      if (ce) {
        onNotify(errorMessage(ce), false);
        return;
      }
      targetId = createdId as string;
    }
    setBusy(true);
    const { error } = await supabase.functions.invoke('ai-generate', {
      body: { kind: 'endsem_set', course_id: course.id, assessment_id: targetId },
    });
    setBusy(false);
    if (error) {
      onNotify(errorMessage(error), false);
    } else {
      onNotify('Generated 40 end-sem candidates.', true);
      await loadAssessment();
    }
  }

  async function handleToggleApprove(questionId: string, currentlyApproved: boolean) {
    if (!assessment) return;
    const currentApproved = candidates.filter((c) => c.approved).map((c) => c.question_id);
    const next = currentlyApproved
      ? currentApproved.filter((id) => id !== questionId)
      : [...currentApproved, questionId];
    setBusy(true);
    const { error } = await supabase.rpc('pick_assessment_questions', {
      p_assessment_id: assessment.id,
      p_question_ids: next,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else await loadAssessment();
  }

  async function handleAssistPick30() {
    if (!assessment) return;
    const flat = candidates
      .map((c) => c.questions)
      .filter((q): q is NonNullable<CandidateRow['questions']> => Boolean(q));
    const coCodes = outcomes.filter((o) => selectedCos.includes(o.id)).map((o) => o.code);
    const picked = assistPickBest30(flat, coCodes);
    setBusy(true);
    const { error } = await supabase.rpc('pick_assessment_questions', {
      p_assessment_id: assessment.id,
      p_question_ids: picked,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify(`Assist selected ${picked.length} valid questions.`, true);
      await loadAssessment();
    }
  }

  async function handleSendToHod() {
    if (!assessment) return;
    setBusy(true);
    const { error } = await supabase.rpc('send_assessment_to_hod', {
      p_assessment_id: assessment.id,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify('End-sem 30-question set sent to HOD for approval.', true);
      await loadAssessment();
    }
  }

  async function handleSchedule() {
    if (!assessment) return;
    setBusy(true);
    const { error } = await supabase.rpc('schedule_assessment', {
      p_assessment_id: assessment.id,
      p_at: new Date(schedDate).toISOString(),
      p_room: schedRoom,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify('End-sem scheduled and students notified.', true);
      await loadAssessment();
    }
  }

  async function handleSaveAndActivate() {
    if (!assessment) return;
    const entries = batchStudents.map((s) => ({
      student_id: s.id,
      state: attMap[s.id] ?? 'present',
    }));
    setBusy(true);
    const { error: ae } = await supabase.rpc('save_exam_attendance', {
      p_assessment_id: assessment.id,
      p_entries: entries,
    });
    if (ae) {
      setBusy(false);
      onNotify(errorMessage(ae), false);
      return;
    }
    const { error: actErr } = await supabase.rpc('activate_assessment', {
      p_assessment_id: assessment.id,
    });
    setBusy(false);
    if (actErr) onNotify(errorMessage(actErr), false);
    else {
      onNotify('Attendance confirmed and test activated.', true);
      await loadAssessment();
    }
  }

  async function handleMarkLatePresent(studentId: string) {
    if (!assessment) return;
    const { error } = await supabase.rpc('save_exam_attendance', {
      p_assessment_id: assessment.id,
      p_entries: [{ student_id: studentId, state: 'present' }],
    });
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify('Student marked present.', true);
      await loadAssessment();
    }
  }

  async function handleGrantExtraTime(paperId: string, minutes = 15) {
    const { error } = await supabase.rpc('grant_extra_time', {
      p_paper_id: paperId,
      p_minutes: minutes,
    });
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify(`Granted +${minutes} min.`, true);
      await loadAssessment();
    }
  }

  async function handleEndTest() {
    if (!assessment) return;
    setBusy(true);
    const { error } = await supabase.rpc('end_assessment', {
      p_assessment_id: assessment.id,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify('Test ended. Remaining papers autosubmitted.', true);
      await loadAssessment();
    }
  }

  async function handleReviewEvent(eventId: string) {
    const { error } = await supabase.rpc('review_proctor_event', {
      p_event_id: eventId,
    });
    if (error) onNotify(errorMessage(error), false);
    else await loadAssessment();
  }

  async function handleSaveViva(studentId: string, marks: number) {
    if (!assessment) return;
    const { error } = await supabase.rpc('save_exam_viva', {
      p_assessment_id: assessment.id,
      p_student_id: studentId,
      p_marks: marks,
    });
    if (error) onNotify(errorMessage(error), false);
    else await loadAssessment();
  }

  async function handleAddToCourseFile() {
    if (!assessment) return;
    setBusy(true);
    const { error } = await supabase.rpc('add_assessment_to_file', {
      p_assessment_id: assessment.id,
    });
    setBusy(false);
    if (error) onNotify(errorMessage(error), false);
    else {
      onNotify('End-sem marks and attainment added to course file (sections 11–13).', true);
      await loadAssessment();
      onRefresh();
    }
  }

  const approvedCount = candidates.filter((c) => c.approved).length;
  const unreviewedFlagCount = events.filter(
    (ev) => ev.reviewed_at === null && papers.some((p) => p.id === ev.paper_id && p.flagged),
  ).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Batch selector */}
      <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, marginRight: 'auto' }}>
          End-sem assessments
        </h1>
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>Batch</label>
        <select
          aria-label="Batch"
          value={batchId}
          onChange={(e) => setBatchId(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }}
        >
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {/* Six-stage stepper */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {STAGE_ORDER.map((s, idx) => {
          const locked = idx > currentStageIdx;
          const active = viewStage === s.key;
          return (
            <button
              key={s.key}
              type="button"
              disabled={locked}
              onClick={() => setViewStage(s.key)}
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: locked ? '#f1f5f9' : 'var(--surface)',
                color: locked ? '#94a3b8' : 'var(--text)',
                textAlign: 'left',
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: locked ? 0.65 : 1,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: locked ? '#94a3b8' : 'var(--muted)' }}>
                {s.code}
              </div>
              <div style={{ fontSize: 13, fontWeight: active ? 700 : 500 }}>{s.label}</div>
            </button>
          );
        })}
      </div>

      {/* E1: Rules */}
      {viewStage === 'rules' && (
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 12 }}>E1 · Rules</h2>
          {assessment?.rules_locked && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: '#fff7ed', color: '#9a3412', fontSize: 13 }}>
              Rules are locked because question generation has started.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <label style={{ fontSize: 13 }}>
              Questions / student
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.questions_per_student}
                onChange={(e) => setRules({ ...rules, questions_per_student: Number(e.target.value) })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Easy (of 40)
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.mix.easy}
                onChange={(e) => setRules({ ...rules, mix: { ...rules.mix, easy: Number(e.target.value) } })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Medium (of 40)
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.mix.medium}
                onChange={(e) => setRules({ ...rules, mix: { ...rules.mix, medium: Number(e.target.value) } })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Hard (of 40)
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.mix.hard}
                onChange={(e) => setRules({ ...rules, mix: { ...rules.mix, hard: Number(e.target.value) } })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Visible tests
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.visible_count}
                onChange={(e) => setRules({ ...rules, visible_count: Number(e.target.value) })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Hidden tests
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.hidden_count}
                onChange={(e) => setRules({ ...rules, hidden_count: Number(e.target.value) })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Marks / test
              <input
                type="number"
                disabled={assessment?.rules_locked}
                value={rules.marks_per_test}
                onChange={(e) => setRules({ ...rules, marks_per_test: Number(e.target.value) })}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Viva / Duration (min)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  type="number"
                  disabled={assessment?.rules_locked}
                  value={rules.viva_marks}
                  onChange={(e) => setRules({ ...rules, viva_marks: Number(e.target.value) })}
                  style={{ width: '50%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                />
                <input
                  type="number"
                  disabled={assessment?.rules_locked}
                  value={rules.duration_min}
                  onChange={(e) => setRules({ ...rules, duration_min: Number(e.target.value) })}
                  style={{ width: '50%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                />
              </div>
            </label>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>COs covered</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {outcomes.map((o) => (
                <label key={o.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    disabled={assessment?.rules_locked}
                    checked={selectedCos.includes(o.id)}
                    onChange={(e) =>
                      setSelectedCos((prev) =>
                        e.target.checked ? [...prev, o.id] : prev.filter((id) => id !== o.id),
                      )
                    }
                  />
                  {o.code}
                </label>
              ))}
            </div>
          </div>

          <div style={{ padding: 12, borderRadius: 6, background: 'var(--bg)', fontSize: 13, marginBottom: 16 }}>
            Computed paper: <strong>{breakdown.perQuestion} marks per question</strong> · coding{' '}
            <strong>{breakdown.codingTotal}</strong> + viva <strong>{breakdown.viva}</strong> ={' '}
            <strong>Total {breakdown.total} marks</strong>
          </div>

          {!assessment?.rules_locked && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn" disabled={busy} onClick={handleSaveRules}>
                Save rules
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={handleGenerate40}>
                Generate 40 questions (1 AI run)
              </button>
            </div>
          )}
        </div>
      )}

      {/* E2: Generate & approve 30 */}
      {viewStage === 'generate' && (
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, marginRight: 'auto' }}>
              E2 · Select 30 of 40 ({approvedCount}/30 selected)
            </h2>
            <button type="button" className="btn" disabled={busy} onClick={handleAssistPick30}>
              Assist pick best 30
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || approvedCount !== 30}
              onClick={handleSendToHod}
            >
              Add to question bank and send to HOD
            </button>
          </div>
          {assessment?.hod_status === 'declined' && assessment.hod_remark && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>
              Returned by HOD: {assessment.hod_remark}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Pick</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Title</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>CO</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Difficulty</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Valid</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const valid = c.questions?.valid === true;
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', opacity: valid ? 1 : 0.45 }}>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="checkbox"
                        disabled={!valid || busy}
                        checked={c.approved}
                        onChange={() => handleToggleApprove(c.question_id, c.approved)}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>{c.questions?.title ?? c.question_id}</td>
                    <td style={{ padding: '6px 8px' }}>{c.questions?.co_code}</td>
                    <td style={{ padding: '6px 8px' }}>{c.questions?.difficulty}</td>
                    <td style={{ padding: '6px 8px' }}>{valid ? 'Valid' : 'Invalid'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* E3: HOD approval */}
      {viewStage === 'hod_pending' && (
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 8 }}>E3 · HOD approval</h2>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
            The 30-question set is locked and awaiting HOD review. Status: <strong>{assessment?.hod_status}</strong>.
          </p>
        </div>
      )}

      {/* E4: Schedule */}
      {viewStage === 'scheduled' && (
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 12 }}>E4 · Schedule</h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
            <label style={{ fontSize: 13 }}>
              Date and time
              <input
                type="datetime-local"
                value={schedDate}
                onChange={(e) => setSchedDate(e.target.value)}
                style={{ display: 'block', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              Room
              <input
                type="text"
                value={schedRoom}
                onChange={(e) => setSchedRoom(e.target.value)}
                style={{ display: 'block', marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </label>
            <button type="button" className="btn-primary" disabled={busy} onClick={handleSchedule}>
              Save schedule & notify students
            </button>
          </div>
          {assessment?.scheduled_at && (
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              Scheduled for {new Date(assessment.scheduled_at).toLocaleString('en-IN')} in {assessment.room}.{' '}
              <button type="button" className="btn" onClick={() => setViewStage('live')}>
                Proceed to attendance & conduct
              </button>
            </div>
          )}
        </div>
      )}

      {/* E5: Attendance & live proctor panel */}
      {viewStage === 'live' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, marginRight: 'auto' }}>
                E5 · Attendance seat grid
              </h2>
              {assessment?.stage !== 'live' ? (
                <button type="button" className="btn-primary" disabled={busy} onClick={handleSaveAndActivate}>
                  Confirm attendance and activate test
                </button>
              ) : (
                <button type="button" className="btn" disabled={busy} onClick={handleEndTest}>
                  End test
                </button>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Roll</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Name</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Attendance</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {batchStudents.map((s) => {
                  const st = attMap[s.id] ?? 'present';
                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="mono" style={{ padding: '6px 8px' }}>{s.roll_no ?? '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{s.full_name}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <select
                          value={st}
                          onChange={(e) =>
                            setAttMap((prev) => ({
                              ...prev,
                              [s.id]: e.target.value as 'present' | 'late' | 'absent',
                            }))
                          }
                        >
                          <option value="present">present</option>
                          <option value="late">late</option>
                          <option value="absent">absent</option>
                        </select>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {assessment?.stage === 'live' && st !== 'present' && (
                          <button type="button" className="btn" onClick={() => handleMarkLatePresent(s.id)}>
                            Mark present
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {assessment?.stage === 'live' && (
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 10 }}>
                Live proctor panel (polls every 5 s)
              </h3>
              <div style={{ display: 'flex', gap: 24, fontSize: 13, marginBottom: 12 }}>
                <span>Started: <strong>{papers.length}</strong></span>
                <span>Absent: <strong>{batchStudents.filter((s) => (attMap[s.id] ?? 'present') === 'absent').length}</strong></span>
                <span>Flagged: <strong>{papers.filter((p) => p.flagged).length}</strong></span>
                <span>Submitted: <strong>{papers.filter((p) => p.submitted_at).length}</strong></span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Student</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Flags</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Extra min</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {papers.map((p) => {
                    const stu = batchStudents.find((s) => s.id === p.student_id);
                    const evCnt = events.filter((e) => e.paper_id === p.id).length;
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 8px' }}>{stu?.full_name ?? p.student_id}</td>
                        <td style={{ padding: '6px 8px' }}>{p.submitted_at ? 'Submitted' : 'In progress'}</td>
                        <td style={{ padding: '6px 8px', color: p.flagged ? '#dc2626' : 'inherit' }}>
                          {evCnt} {p.flagged ? '(Flagged)' : ''}
                        </td>
                        <td style={{ padding: '6px 8px' }}>+{p.extra_minutes}m</td>
                        <td style={{ padding: '6px 8px' }}>
                          <button type="button" className="btn" onClick={() => handleGrantExtraTime(p.id, 15)}>
                            +15 min
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* E6: Marks & attainment */}
      {viewStage === 'marks' && (
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, marginRight: 'auto' }}>
              E6 · Marks & attainment
            </h2>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || assessment?.added_to_file || unreviewedFlagCount > 0}
              onClick={handleAddToCourseFile}
            >
              {assessment?.added_to_file ? 'Added to course file' : 'Add to course file'}
            </button>
          </div>
          {unreviewedFlagCount > 0 && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: '#fff7ed', color: '#9a3412', fontSize: 13 }}>
              Review all {unreviewedFlagCount} flagged proctor event(s) before adding to the course file.
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Roll</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Name</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Coding</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Viva</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Total /60</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Proctor</th>
              </tr>
            </thead>
            <tbody>
              {batchStudents.map((s) => {
                const paper = papers.find((p) => p.student_id === s.id);
                const codingMarks = paper
                  ? paper.q_ids.reduce((acc, qid) => {
                      const sub = subs.find((x) => x.student_id === s.id && x.question_id === qid);
                      return acc + (sub?.marks ?? 0);
                    }, 0)
                  : 0;
                const viva = vivaMap[s.id] ?? 0;
                const total = paper ? codingMarks + viva : null;
                const paperEvents = paper ? events.filter((e) => e.paper_id === paper.id) : [];
                const pendingRev = paperEvents.some((e) => e.reviewed_at === null);
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="mono" style={{ padding: '6px 8px' }}>{s.roll_no ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{s.full_name}</td>
                    <td style={{ padding: '6px 8px' }}>{paper ? codingMarks : 'Absent'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {paper ? (
                        <input
                          type="number"
                          min={0}
                          max={rules.viva_marks}
                          value={viva}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setVivaMap((prev) => ({ ...prev, [s.id]: val }));
                          }}
                          onBlur={() => handleSaveViva(s.id, vivaMap[s.id] ?? 0)}
                          style={{ width: 64, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4 }}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{total !== null ? `${total}/60` : 'Absent'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {!paper ? '—' : !paper.flagged ? 'Clean' : pendingRev ? 'Flagged (review below)' : 'Reviewed'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {events.length > 0 && (
            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Proctor flags</h3>
              {events.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <span className="mono">{ev.event_type}</span>
                  <span style={{ color: 'var(--muted)', flex: 1 }}>{ev.detail}</span>
                  {ev.reviewed_at ? (
                    <span style={{ color: '#16a34a' }}>Reviewed</span>
                  ) : (
                    <button type="button" className="btn" onClick={() => handleReviewEvent(ev.id)}>
                      Mark reviewed
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
