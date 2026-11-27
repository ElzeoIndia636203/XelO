import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Banner, Card, Chip, Empty, Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateTimeIst } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { fn, rpc, supabase } from '../../../lib/supabase';
import type { Batch, Course, CourseOutcome, Enrollment, Profile } from '../../../lib/types';

interface InstantTestCase {
  input: string;
  expected: string;
}

interface InstantQuestionDraft {
  id: string;
  slot: number;
  variant: number;
  title: string;
  statement: string;
  input_spec: string;
  output_spec: string;
  constraints: string;
  sample_input: string;
  sample_output: string;
  difficulty: 'easy' | 'medium' | 'hard';
  marks: number;
  co_code: string;
  visible_marks: number;
  hidden_marks: number;
  visible_tests: InstantTestCase[];
  hidden_tests: InstantTestCase[];
}

interface InstantPretestDraft {
  id: string;
  stem: string;
  options: [string, string, string, string];
  correct_index: number;
}

interface InstantTestRow {
  id: string;
  test_code: string;
  topic: string;
  total_marks: number;
  question_count: number;
  difficulty: string;
  co_code: string;
  visible_count: number;
  hidden_count: number;
  visible_marks: number;
  hidden_marks: number;
  pretest_count: number;
  pretest_difficulty: string;
  pretest_marks: number;
  viva_marks: number;
  scope_type: 'class' | 'batch' | 'students';
  status: 'scheduled' | 'active' | 'closed' | 'finalized';
  scheduled_at: string | null;
  conducted_at: string | null;
  allowed_langs: string[];
  active: boolean;
  created_at: string;
}

interface InstantParticipantRow {
  id: string;
  test_id: string;
  student_id: string;
  batch_id: string | null;
  attendance_status: 'pending' | 'present' | 'absent';
  added_manually: boolean;
  approval_status?: 'pending' | 'approved' | 'rejected';
  requested_via_code?: boolean;
  requested_prn?: string | null;
  requested_name?: string | null;
}

interface InstantAnswerItem {
  lang?: string;
  code?: string;
  visible_passed?: number;
  visible_total?: number;
  hidden_passed?: number;
  hidden_total?: number;
  visible_marks_earned?: number;
  hidden_marks_earned?: number;
  marks_awarded?: number;
}

interface InstantAttemptRow {
  id: string;
  test_id: string;
  student_id: string;
  prn: string;
  student_name: string;
  answers: Record<string, InstantAnswerItem>;
  pretest_score: number;
  coding_score: number;
  coding_override_score: number | null;
  override_reason: string;
  code_approved: boolean;
  viva_score: number;
  final_score: number;
  total_score: number;
  marks_approved: boolean;
  approved_at: string | null;
  submitted_at: string | null;
  started_at: string;
}

const ALL_LANGS = [
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'java', label: 'Java' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
] as const;

export function InstantTestStep({
  course,
  outcomes,
  batches = [],
  enrollments = [],
  studentProfiles = [],
  onNotify,
}: {
  course: Course;
  outcomes: readonly CourseOutcome[];
  batches?: readonly Batch[];
  enrollments?: readonly Enrollment[];
  studentProfiles?: readonly Profile[];
  onNotify: (msg: string, ok: boolean) => void;
}) {
  const { profile } = useSession();
  const [topic, setTopic] = useState('');
  const [questionCount, setQuestionCount] = useState(2);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [coId, setCoId] = useState(outcomes[0]?.id ?? '');
  const [visibleCount, setVisibleCount] = useState(2);
  const [hiddenCount, setHiddenCount] = useState(3);
  const [visibleMarks, setVisibleMarks] = useState(4);
  const [hiddenMarks, setHiddenMarks] = useState(6);

  const [pretestCount, setPretestCount] = useState(0);
  const [pretestDifficulty, setPretestDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [pretestMarks, setPretestMarks] = useState(0);
  const [pretestQuestions, setPretestQuestions] = useState<InstantPretestDraft[]>([]);
  const [vivaMarks, setVivaMarks] = useState(0);

  const [scopeType, setScopeType] = useState<'class' | 'batch' | 'students'>('class');
  const [targetBatchIds, setTargetBatchIds] = useState<string[]>([]);
  const [targetStudentIds, setTargetStudentIds] = useState<string[]>([]);
  const [activateNow, setActivateNow] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  const [langs, setLangs] = useState<string[]>(() =>
    course.allowed_langs.length > 0 ? [...course.allowed_langs] : ['c', 'python'],
  );
  const [questions, setQuestions] = useState<InstantQuestionDraft[]>([]);
  const [activeSlot, setActiveSlot] = useState(1);
  const [activeVariant, setActiveVariant] = useState(1);
  const [genProgress, setGenProgress] = useState('');

  const [tests, setTests] = useState<InstantTestRow[]>([]);
  const [attemptsByTest, setAttemptsByTest] = useState<Record<string, InstantAttemptRow[]>>({});
  const [participantsByTest, setParticipantsByTest] = useState<Record<string, InstantParticipantRow[]>>({});
  const [busy, setBusy] = useState(false);

  // Modals: attendance & activate, add live students, code inspect & grade, roll-no report
  const [attendanceTest, setAttendanceTest] = useState<InstantTestRow | null>(null);
  const [presentIds, setPresentIds] = useState<string[]>([]);
  const [addStudentTest, setAddStudentTest] = useState<InstantTestRow | null>(null);
  const [addStudentIds, setAddStudentIds] = useState<string[]>([]);
  const [inspectCtx, setInspectCtx] = useState<{ test: InstantTestRow; attempt: InstantAttemptRow } | null>(null);
  const [gradeApprove, setGradeApprove] = useState(true);
  const [gradeOverride, setGradeOverride] = useState('');
  const [gradeReason, setGradeReason] = useState('');
  const [gradeViva, setGradeViva] = useState('0');
  const [reportTest, setReportTest] = useState<InstantTestRow | null>(null);

  const selectedCo = outcomes.find((o) => o.id === coId) ?? outcomes[0] ?? null;
  const studentMap = new Map(studentProfiles.map((p) => [p.id, p]));
  const computedTotalMarks = Number(
    (
      (pretestCount > 0 ? pretestMarks : 0) +
      questionCount * (visibleMarks + hiddenMarks) +
      vivaMarks
    ).toFixed(2),
  );

  const fetchTests = useCallback(async () => {
    const { data: tRows } = await supabase
      .from('instant_tests')
      .select('*')
      .eq('course_id', course.id)
      .order('created_at', { ascending: false });
    const typedTests = (tRows ?? []) as InstantTestRow[];
    const grouped: Record<string, InstantAttemptRow[]> = {};
    const groupedParts: Record<string, InstantParticipantRow[]> = {};

    if (typedTests.length > 0) {
      const ids = typedTests.map((t) => t.id);
      const [aRes, pRes] = await Promise.all([
        supabase
          .from('instant_test_attempts')
          .select('*')
          .in('test_id', ids)
          .order('prn', { ascending: true }),
        supabase
          .from('instant_test_participants')
          .select('*')
          .in('test_id', ids),
      ]);

      for (const a of (aRes.data ?? []) as InstantAttemptRow[]) {
        if (!grouped[a.test_id]) grouped[a.test_id] = [];
        grouped[a.test_id]!.push(a);
      }
      for (const p of (pRes.data ?? []) as InstantParticipantRow[]) {
        if (!groupedParts[p.test_id]) groupedParts[p.test_id] = [];
        groupedParts[p.test_id]!.push(p);
      }
    }
    return { typedTests, grouped, groupedParts };
  }, [course.id]);

  const reloadAll = useCallback(async () => {
    const res = await fetchTests();
    setTests(res.typedTests);
    setAttemptsByTest(res.grouped);
    setParticipantsByTest(res.groupedParts);
  }, [fetchTests]);

  useEffect(() => {
    let cancelled = false;
    void fetchTests().then((res) => {
      if (cancelled) return;
      setTests(res.typedTests);
      setAttemptsByTest(res.grouped);
      setParticipantsByTest(res.groupedParts);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchTests]);

  function toggleLang(id: string) {
    setLangs((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((l) => l !== id) : prev) : [...prev, id],
    );
  }

  function syncPretestSlots(nextCount: number) {
    setPretestCount(nextCount);
    if (nextCount === 0) {
      setPretestMarks(0);
      setPretestQuestions([]);
      return;
    }
    setPretestQuestions((prev) => {
      const next = [...prev];
      while (next.length < nextCount) {
        const idx = next.length + 1;
        next.push({
          id: `pre_${idx}`,
          stem: '',
          options: ['', '', '', ''],
          correct_index: 0,
        });
      }
      return next.slice(0, nextCount);
    });
  }

  async function generateAiBuckets() {
    if (!topic.trim()) {
      onNotify('Enter a topic before generating question buckets.', false);
      return;
    }
    if (visibleCount < 1 || hiddenCount < 1) {
      onNotify('At least 1 visible and 1 hidden test case are required.', false);
      return;
    }
    setBusy(true);
    const perQMarks = Number((visibleMarks + hiddenMarks).toFixed(2));
    const allBuilt: InstantQuestionDraft[] = [];
    const avoidTitles: string[] = [];

    try {
      for (let slot = 1; slot <= questionCount; slot++) {
        setGenProgress(`Generating AI question variants for Question ${slot} of ${questionCount}…`);
        const res = await fn<{
          questions: Array<{
            title: string;
            statement: string;
            input_spec: string;
            output_spec: string;
            constraints: string;
            sample_input: string;
            sample_output: string;
            difficulty: 'easy' | 'medium' | 'hard';
            visible_tests: InstantTestCase[];
            hidden_tests: InstantTestCase[];
          }>;
        }>('ai-generate', {
          kind: 'instant_test_bucket',
          course_id: course.id,
          topic: topic.trim(),
          slot,
          bucket_size: 5,
          difficulty,
          co_code: selectedCo?.code ?? 'CO1',
          visible_count: visibleCount,
          hidden_count: hiddenCount,
          avoid_titles: avoidTitles,
        });

        for (let vi = 0; vi < res.questions.length; vi++) {
          const item = res.questions[vi]!;
          avoidTitles.push(item.title);
          allBuilt.push({
            id: `s${slot}_v${vi + 1}`,
            slot,
            variant: vi + 1,
            title: item.title,
            statement: item.statement,
            input_spec: item.input_spec,
            output_spec: item.output_spec,
            constraints: item.constraints,
            sample_input: item.sample_input,
            sample_output: item.sample_output,
            difficulty: item.difficulty,
            marks: perQMarks,
            co_code: selectedCo?.code ?? 'CO1',
            visible_marks: visibleMarks,
            hidden_marks: hiddenMarks,
            visible_tests: item.visible_tests,
            hidden_tests: item.hidden_tests,
          });
        }
      }
      setQuestions(allBuilt);
      setActiveSlot(1);
      setActiveVariant(1);
      onNotify(`Generated ${allBuilt.length} AI questions (${questionCount} slots × 5 variants).`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setGenProgress('');
      setBusy(false);
    }
  }

  async function publishTest(e: FormEvent) {
    e.preventDefault();
    if (!topic.trim() || questions.length === 0) {
      onNotify('Enter a topic and generate the AI question buckets before saving.', false);
      return;
    }
    if (visibleCount < 1 || hiddenCount < 1 || questions.some((q) => q.visible_tests.length < 1 || q.hidden_tests.length < 1)) {
      onNotify('Every question must have at least 1 visible and 1 hidden test case.', false);
      return;
    }
    if (computedTotalMarks <= 0) {
      onNotify('Total marks must be greater than 0.', false);
      return;
    }
    if (scopeType === 'batch' && targetBatchIds.length === 0) {
      onNotify('Select at least one batch.', false);
      return;
    }
    if (scopeType === 'students' && targetStudentIds.length === 0) {
      onNotify('Select at least one student.', false);
      return;
    }
    if (pretestCount > 0 && pretestQuestions.some((pq) => !pq.stem.trim() || pq.options.some((o) => !o.trim()))) {
      onNotify('Fill in all pre-test MCQ stems and options.', false);
      return;
    }

    setBusy(true);
    try {
      const res = await rpc<{ id: string; test_code?: string; status?: string }>('faculty_create_instant_test', {
        p_course_id: course.id,
        p_topic: topic.trim(),
        p_total_marks: computedTotalMarks,
        p_question_count: questionCount,
        p_difficulty: difficulty,
        p_co_id: selectedCo?.id ?? null,
        p_co_code: selectedCo?.code ?? '',
        p_visible_count: visibleCount,
        p_hidden_count: hiddenCount,
        p_visible_marks: visibleMarks,
        p_hidden_marks: hiddenMarks,
        p_allowed_langs: langs,
        p_questions: questions,
        p_scope_type: scopeType,
        p_target_batch_ids: targetBatchIds,
        p_target_student_ids: targetStudentIds,
        p_scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        p_activate_now: activateNow,
        p_pretest_count: pretestCount,
        p_pretest_difficulty: pretestDifficulty,
        p_pretest_marks: pretestCount > 0 ? pretestMarks : 0,
        p_pretest_questions: pretestCount > 0 ? pretestQuestions : [],
        p_viva_marks: vivaMarks,
      });
      onNotify(
        activateNow
          ? `Instant coding test activated! Code ${res.test_code ?? ''} · Students notified.`
          : `Instant coding test scheduled! Code ${res.test_code ?? ''} · Confirm attendance on exam day to activate.`,
        true,
      );
      setTopic('');
      setQuestions([]);
      setScheduledAt('');
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAttendanceAndActivate() {
    if (!attendanceTest) return;
    setBusy(true);
    try {
      await rpc('faculty_confirm_attendance_and_activate', {
        p_test_id: attendanceTest.id,
        p_present_student_ids: presentIds,
      });
      onNotify(`Confirmed attendance (${presentIds.length} present) and activated ${attendanceTest.topic}.`, true);
      setAttendanceTest(null);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function addStudentsToTest() {
    if (!addStudentTest || addStudentIds.length === 0) return;
    setBusy(true);
    try {
      const count = await rpc<number>('faculty_add_instant_test_students', {
        p_test_id: addStudentTest.id,
        p_student_ids: addStudentIds,
      });
      onNotify(`Added ${count} student(s) to ${addStudentTest.topic}.`, true);
      setAddStudentTest(null);
      setAddStudentIds([]);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function saveInspectGrade(e: FormEvent) {
    e.preventDefault();
    if (!inspectCtx) return;
    const { test, attempt } = inspectCtx;
    const overrideNum = gradeOverride.trim() === '' ? null : Number(gradeOverride);
    if (overrideNum !== null) {
      if (Number.isNaN(overrideNum) || overrideNum < 0) {
        onNotify('Override mark must be 0 or higher.', false);
        return;
      }
      if (overrideNum > attempt.coding_score) {
        onNotify('Override marks cannot increase obtained coding marks — only decrease is allowed.', false);
        return;
      }
    }
    const vivaNum = Number(gradeViva || 0);
    if (Number.isNaN(vivaNum) || vivaNum < 0 || vivaNum > test.viva_marks) {
      onNotify(`Viva marks must be between 0 and ${test.viva_marks}.`, false);
      return;
    }
    setBusy(true);
    try {
      await rpc('faculty_inspect_and_grade_instant_attempt', {
        p_attempt_id: attempt.id,
        p_approve_code: gradeApprove,
        p_override_coding_score: overrideNum,
        p_override_reason: gradeReason.trim(),
        p_viva_score: vivaNum,
      });
      onNotify(`Saved grading for ${attempt.prn} (${attempt.student_name}).`, true);
      setInspectCtx(null);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function reviewJoinRequest(testId: string, studentId: string, approve: boolean) {
    setBusy(true);
    try {
      await rpc('faculty_review_instant_join_request', {
        p_test_id: testId,
        p_student_id: studentId,
        p_approve: approve,
      });
      onNotify(approve ? 'Student approved and admitted to the test.' : 'Join request declined.', true);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function finalizeMarks(test: InstantTestRow) {
    if (!window.confirm(`Submit & approve final marks for "${test.topic}"?`)) return;
    setBusy(true);
    try {
      await rpc('faculty_finalize_instant_test_marks', { p_test_id: test.id });
      onNotify(`Marks submitted and approved for ${test.topic}.`, true);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTestActive(test: InstantTestRow) {
    setBusy(true);
    try {
      await rpc('faculty_toggle_instant_test', {
        p_test_id: test.id,
        p_active: !test.active,
      });
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Schedule or create instant coding test">
        <form onSubmit={publishTest} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10 }}>
            <label className="field-label" style={{ gridColumn: 'span 2' }}>
              Topic
              <input
                className="field"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Arrays & Two Pointers"
              />
            </label>
            <label className="field-label">
              No. of coding Qs
              <input
                className="field mono"
                type="number"
                min={1}
                max={20}
                value={questionCount}
                onChange={(e) => setQuestionCount(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <label className="field-label">
              Coding difficulty
              <select
                className="field"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as 'easy' | 'medium' | 'hard' | 'mixed')}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="mixed">Mixed</option>
              </select>
            </label>
            <label className="field-label">
              Mapped CO
              <select className="field" value={selectedCo?.id ?? ''} onChange={(e) => setCoId(e.target.value)}>
                {outcomes.length === 0 ? <option value="">None</option> : null}
                {outcomes.map((co) => (
                  <option key={co.id} value={co.id}>
                    {co.code} (L{co.btl})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              Rubric & weightage (Total: {computedTotalMarks} marks · Pre-test & Viva can be 0; ≥1 visible & ≥1 hidden test mandatory)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10 }}>
              <label className="field-label">
                Visible tests (min 1)
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  max={10}
                  value={visibleCount}
                  onChange={(e) => setVisibleCount(Math.max(1, Number(e.target.value)))}
                />
              </label>
              <label className="field-label">
                Visible marks / Q
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  step="0.5"
                  value={visibleMarks}
                  onChange={(e) => setVisibleMarks(Math.max(0, Number(e.target.value)))}
                />
              </label>
              <label className="field-label">
                Hidden tests (min 1)
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  max={10}
                  value={hiddenCount}
                  onChange={(e) => setHiddenCount(Math.max(1, Number(e.target.value)))}
                />
              </label>
              <label className="field-label">
                Hidden marks / Q
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  step="0.5"
                  value={hiddenMarks}
                  onChange={(e) => setHiddenMarks(Math.max(0, Number(e.target.value)))}
                />
              </label>
              <label className="field-label">
                Pre-test MCQs (0 = none)
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  max={20}
                  value={pretestCount}
                  onChange={(e) => syncPretestSlots(Math.min(20, Math.max(0, Math.trunc(Number(e.target.value) || 0))))}
                />
              </label>
              <label className="field-label">
                Pre-test difficulty
                <select
                  className="field"
                  disabled={pretestCount === 0}
                  value={pretestDifficulty}
                  onChange={(e) => setPretestDifficulty(e.target.value as 'easy' | 'medium' | 'hard' | 'mixed')}
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label className="field-label">
                Pre-test marks (0 = none)
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  step="0.5"
                  disabled={pretestCount === 0}
                  value={pretestCount === 0 ? 0 : pretestMarks}
                  onChange={(e) => setPretestMarks(Math.max(0, Number(e.target.value)))}
                />
              </label>
              <label className="field-label">
                Viva marks (0 = none)
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  step="0.5"
                  value={vivaMarks}
                  onChange={(e) => setVivaMarks(Math.max(0, Number(e.target.value)))}
                />
              </label>
            </div>
          </div>

          {pretestCount > 0 && (
            <div style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Pre-test MCQ questions ({pretestQuestions.length})</div>
              {pretestQuestions.map((pq, i) => (
                <div key={pq.id} style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <input
                    className="field field-sm"
                    placeholder={`MCQ ${i + 1} question stem`}
                    value={pq.stem}
                    onChange={(e) =>
                      setPretestQuestions((prev) => prev.map((x, xi) => (xi === i ? { ...x, stem: e.target.value } : x)))
                    }
                    style={{ marginBottom: 6 }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6 }}>
                    {pq.options.map((opt, oi) => (
                      <div key={oi} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="radio"
                          name={`ans-${pq.id}`}
                          checked={pq.correct_index === oi}
                          onChange={() =>
                            setPretestQuestions((prev) =>
                              prev.map((x, xi) => (xi === i ? { ...x, correct_index: oi } : x)),
                            )
                          }
                        />
                        <input
                          className="field field-sm"
                          placeholder={`Option ${oi + 1}`}
                          value={opt}
                          onChange={(e) =>
                            setPretestQuestions((prev) =>
                              prev.map((x, xi) =>
                                xi === i
                                  ? {
                                      ...x,
                                      options: x.options.map((o, ooi) => (ooi === oi ? e.target.value : o)) as [
                                        string,
                                        string,
                                        string,
                                        string,
                                      ],
                                    }
                                  : x,
                              ),
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Target students & schedule</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <label className="field-label">
                Assign to
                <select
                  className="field field-sm"
                  value={scopeType}
                  onChange={(e) => setScopeType(e.target.value as 'class' | 'batch' | 'students')}
                >
                  <option value="class">1. Whole class ({enrollments.length} students)</option>
                  <option value="batch">2. Particular batch(es)</option>
                  <option value="students">3. Particular students</option>
                </select>
              </label>
              <label className="field-label">
                Schedule date & time (optional)
                <input
                  type="datetime-local"
                  className="field field-sm"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 14 }}>
                <input
                  type="checkbox"
                  checked={activateNow}
                  onChange={(e) => setActivateNow(e.target.checked)}
                />
                Activate immediately (unchecked = schedule for exam-day attendance confirmation)
              </label>
            </div>

            {scopeType === 'batch' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {batches.map((b) => (
                  <label key={b.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={targetBatchIds.includes(b.id)}
                      onChange={() =>
                        setTargetBatchIds((prev) =>
                          prev.includes(b.id) ? prev.filter((id) => id !== b.id) : [...prev, b.id],
                        )
                      }
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            )}

            {scopeType === 'students' && (
              <div style={{ maxHeight: 150, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 6 }}>
                {enrollments.map((e) => {
                  const sp = studentMap.get(e.student_id);
                  return (
                    <label key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={targetStudentIds.includes(e.student_id)}
                        onChange={() =>
                          setTargetStudentIds((prev) =>
                            prev.includes(e.student_id)
                              ? prev.filter((id) => id !== e.student_id)
                              : [...prev, e.student_id],
                          )
                        }
                      />
                      <span className="mono">{sp?.roll_no ?? '—'}</span>
                      <span>{sp?.full_name ?? e.student_id.slice(0, 6)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <span className="field-label" style={{ margin: 0 }}>Allowed languages:</span>
            {ALL_LANGS.map((l) => (
              <label key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={langs.includes(l.id)} onChange={() => toggleLang(l.id)} />
                {l.label}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void generateAiBuckets()}>
              {genProgress || `Generate ${questionCount} × 15 AI question buckets (${questionCount * 15} questions)`}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || questions.length === 0}>
              {busy && !genProgress ? 'Saving…' : activateNow ? 'Publish & activate now' : 'Schedule test & notify students'}
            </button>
          </div>

          {questions.length > 0 && (() => {
            const slotQs = questions.filter((x) => x.slot === activeSlot);
            const activeQ = slotQs.find((x) => x.variant === activeVariant) ?? slotQs[0] ?? questions[0]!;
            const updateQ = (patch: Partial<InstantQuestionDraft>) =>
              setQuestions((prev) => prev.map((x) => (x.id === activeQ.id ? { ...x, ...patch } : x)));
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {Array.from({ length: questionCount }, (_, idx) => idx + 1).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={activeSlot === s ? 'btn btn-primary field-sm' : 'btn field-sm'}
                      onClick={() => {
                        setActiveSlot(s);
                        setActiveVariant(1);
                      }}
                    >
                      Q{s} Bucket (15)
                    </button>
                  ))}
                  <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>Variant:</span>
                  <select
                    className="field field-sm"
                    value={activeVariant}
                    onChange={(e) => setActiveVariant(Number(e.target.value))}
                    style={{ width: 95 }}
                  >
                    {slotQs.map((v) => (
                      <option key={v.id} value={v.variant}>
                        #{v.variant}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                    Q{activeQ.slot} · #{activeQ.variant}: {activeQ.title}
                  </div>
                  <textarea
                    className="field"
                    rows={3}
                    value={activeQ.statement}
                    onChange={(e) => updateQ({ statement: e.target.value })}
                    style={{ height: 'auto', padding: 8 }}
                  />
                </div>
              </div>
            );
          })()}
        </form>
      </Card>

      <Card title="Scheduled & live instant coding tests">
        {tests.length === 0 ? (
          <Empty title="No instant tests yet" body="Schedule or publish an instant coding test above." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {tests.map((t) => {
              const parts = participantsByTest[t.id] ?? [];
              const pendingRequests = parts.filter((p) => p.approval_status === 'pending');
              const approvedIds = new Set(
                parts.filter((p) => (p.approval_status ?? 'approved') === 'approved').map((p) => p.student_id),
              );
              const attempts = (attemptsByTest[t.id] ?? [])
                .filter((a) => parts.length === 0 || approvedIds.has(a.student_id))
                .slice()
                .sort((a, b) => a.prn.localeCompare(b.prn));
              return (
                <div key={t.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <span className="mono" style={{ fontSize: 14, fontWeight: 700, padding: '2px 8px', background: '#DCEBE6', color: '#0E5E52', borderRadius: 4, marginRight: 8 }}>
                        {t.test_code}
                      </span>
                      <strong>{t.topic}</strong> · {t.question_count} Qs · {t.total_marks} marks · {t.scope_type} ({approvedIds.size} approved)
                      {t.scheduled_at ? ` · ${formatDateTimeIst(t.scheduled_at)}` : ''}
                    </div>
                    <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip tone={t.status === 'active' ? 'good' : t.status === 'scheduled' ? 'warn' : 'neutral'}>
                        {t.status}
                      </Chip>
                      {t.status !== 'finalized' && (
                        <button
                          type="button"
                          className="btn btn-primary field-sm"
                          disabled={busy}
                          onClick={() => {
                            setAttendanceTest(t);
                            setPresentIds(
                              parts
                                .filter((p) => p.attendance_status === 'present' || p.attendance_status === 'pending')
                                .map((p) => p.student_id),
                            );
                          }}
                        >
                          {t.status === 'scheduled' ? 'Confirm attendance & activate' : 'Attendance'}
                        </button>
                      )}
                      {t.status !== 'finalized' && (
                        <button
                          type="button"
                          className="btn field-sm"
                          disabled={busy}
                          onClick={() => {
                            setAddStudentTest(t);
                            setAddStudentIds([]);
                          }}
                        >
                          Add students
                        </button>
                      )}
                      {t.status !== 'scheduled' && t.status !== 'finalized' && (
                        <button type="button" className="btn field-sm" disabled={busy} onClick={() => void toggleTestActive(t)}>
                          {t.active ? 'Close' : 'Reopen'}
                        </button>
                      )}
                      {attempts.length > 0 && t.status !== 'finalized' && (
                        <button type="button" className="btn field-sm" disabled={busy} onClick={() => void finalizeMarks(t)}>
                          Submit & approve marks
                        </button>
                      )}
                      <button type="button" className="btn field-sm" onClick={() => setReportTest(t)}>
                        Performance report
                      </button>
                    </div>
                  </div>

                  {pendingRequests.length > 0 && (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: '1px solid var(--assist)', background: '#FFF8F0' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                        Join requests via code ({pendingRequests.length} waiting approval — not in reports until approved)
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {pendingRequests.map((req) => {
                          const prof = studentProfiles.find((s) => s.id === req.student_id);
                          const dispName = req.requested_name || prof?.full_name || prof?.email || req.student_id;
                          const dispPrn = req.requested_prn || prof?.roll_no || '—';
                          return (
                            <div key={req.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 13 }}>
                              <span>
                                <strong className="mono">{dispPrn}</strong> · {dispName}
                              </span>
                              <span style={{ display: 'inline-flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn btn-primary field-sm"
                                  disabled={busy}
                                  onClick={() => void reviewJoinRequest(t.id, req.student_id, true)}
                                >
                                  Approve & admit
                                </button>
                                <button
                                  type="button"
                                  className="btn field-sm"
                                  disabled={busy}
                                  onClick={() => void reviewJoinRequest(t.id, req.student_id, false)}
                                >
                                  Decline
                                </button>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {attempts.length > 0 && (
                    <table style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th>PRN</th>
                          <th>Name</th>
                          <th>Pre-test</th>
                          <th>Coding</th>
                          <th>Override</th>
                          <th>Viva</th>
                          <th>Total</th>
                          <th>Status</th>
                          <th style={{ textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((a) => (
                          <tr key={a.id}>
                            <td className="mono">{a.prn}</td>
                            <td>{a.student_name}</td>
                            <td className="mono">{a.pretest_score} / {t.pretest_marks}</td>
                            <td className="mono">{a.coding_score}</td>
                            <td className="mono">{a.coding_override_score ?? '—'}</td>
                            <td className="mono">{a.viva_score} / {t.viva_marks}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>
                              {a.final_score} / {t.total_marks}
                            </td>
                            <td>
                              <Chip tone={a.marks_approved ? 'good' : a.code_approved ? 'neutral' : 'warn'}>
                                {a.marks_approved ? 'Approved' : a.code_approved ? 'Code ok' : 'Pending'}
                              </Chip>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                type="button"
                                className="btn field-sm"
                                onClick={() => {
                                  setInspectCtx({ test: t, attempt: a });
                                  setGradeApprove(a.code_approved || true);
                                  setGradeOverride(a.coding_override_score !== null ? String(a.coding_override_score) : '');
                                  setGradeReason(a.override_reason ?? '');
                                  setGradeViva(String(a.viva_score ?? 0));
                                }}
                              >
                                Code inspect
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        open={attendanceTest !== null}
        title={attendanceTest ? `Confirm attendance · ${attendanceTest.topic}` : 'Attendance'}
        onClose={() => setAttendanceTest(null)}
      >
        {attendanceTest ? (() => {
          const parts = participantsByTest[attendanceTest.id] ?? [];
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Mark present students and click <strong>Confirm attendance & activate</strong>. Questions unlock only for present students once activated.
              </div>
              <div style={{ maxHeight: '48vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {parts.map((p) => {
                  const sp = studentMap.get(p.student_id);
                  const checked = presentIds.includes(p.student_id);
                  return (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPresentIds((prev) =>
                            prev.includes(p.student_id) ? prev.filter((id) => id !== p.student_id) : [...prev, p.student_id],
                          )
                        }
                      />
                      <span className="mono">{sp?.roll_no ?? '—'}</span>
                      <span>{sp?.full_name ?? p.student_id}</span>
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setAttendanceTest(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void confirmAttendanceAndActivate()}
                >
                  {busy ? 'Activating…' : 'Confirm attendance & activate'}
                </button>
              </div>
            </div>
          );
        })() : null}
      </Modal>

      <Modal
        open={addStudentTest !== null}
        title={addStudentTest ? `Add students · ${addStudentTest.topic}` : 'Add students'}
        onClose={() => setAddStudentTest(null)}
      >
        {addStudentTest ? (() => {
          const existingIds = new Set((participantsByTest[addStudentTest.id] ?? []).map((p) => p.student_id));
          const available = enrollments.filter((e) => !existingIds.has(e.student_id));
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {available.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>All enrolled course students are already assigned.</div>
              ) : (
                <div style={{ maxHeight: '48vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {available.map((e) => {
                    const sp = studentMap.get(e.student_id);
                    return (
                      <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={addStudentIds.includes(e.student_id)}
                          onChange={() =>
                            setAddStudentIds((prev) =>
                              prev.includes(e.student_id)
                                ? prev.filter((id) => id !== e.student_id)
                                : [...prev, e.student_id],
                            )
                          }
                        />
                        <span className="mono">{sp?.roll_no ?? '—'}</span>
                        <span>{sp?.full_name ?? e.student_id}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setAddStudentTest(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || addStudentIds.length === 0}
                  onClick={() => void addStudentsToTest()}
                >
                  {busy ? 'Adding…' : `Add ${addStudentIds.length} student(s)`}
                </button>
              </div>
            </div>
          );
        })() : null}
      </Modal>

      <Modal
        open={inspectCtx !== null}
        title={inspectCtx ? `Code inspect · ${inspectCtx.attempt.prn} · ${inspectCtx.attempt.student_name}` : 'Code inspect'}
        onClose={() => setInspectCtx(null)}
      >
        {inspectCtx ? (
          <form onSubmit={saveInspectGrade} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '76vh', overflowY: 'auto' }}>
            <Banner tone="info">
              Obtained coding marks: <strong>{inspectCtx.attempt.coding_score}</strong>. Override can only decrease marks (cannot increase).
            </Banner>
            {Object.entries(inspectCtx.attempt.answers ?? {}).map(([qid, ans]) => (
              <div key={qid} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
                <div className="mono" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {qid} · {ans.lang ?? '—'} · Visible {ans.visible_passed ?? 0}/{ans.visible_total ?? 0} · Hidden {ans.hidden_passed ?? 0}/{ans.hidden_total ?? 0} · Marks: {ans.marks_awarded ?? 0}
                </div>
                <pre className="mono" style={{ margin: 0, padding: 8, background: 'var(--bg-subtle)', borderRadius: 4, fontSize: 11.5, overflowX: 'auto', maxHeight: 200 }}>
                  {ans.code ?? '// No code submitted'}
                </pre>
              </div>
            ))}
            {Object.keys(inspectCtx.attempt.answers ?? {}).length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No code submissions recorded yet.</div>
            ) : null}

            <div className="grid-2">
              <label className="field-label">
                Override coding marks (max {inspectCtx.attempt.coding_score}, decrease only)
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={inspectCtx.attempt.coding_score}
                  className="field mono"
                  value={gradeOverride}
                  onChange={(e) => setGradeOverride(e.target.value)}
                  placeholder="Leave blank to keep obtained"
                />
              </label>
              <label className="field-label">
                Viva marks (0 – {inspectCtx.test.viva_marks})
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={inspectCtx.test.viva_marks}
                  disabled={inspectCtx.test.viva_marks === 0}
                  className="field mono"
                  value={gradeViva}
                  onChange={(e) => setGradeViva(e.target.value)}
                />
              </label>
            </div>
            <label className="field-label">
              Override / inspection remark
              <input className="field" value={gradeReason} onChange={(e) => setGradeReason(e.target.value)} placeholder="Optional remark" />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={gradeApprove} onChange={(e) => setGradeApprove(e.target.checked)} />
              Approve student code & marks
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setInspectCtx(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save inspection & marks'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={reportTest !== null}
        title={reportTest ? `Performance report · ${reportTest.topic}` : 'Performance report'}
        onClose={() => setReportTest(null)}
      >
        {reportTest ? (() => {
          const rParts = participantsByTest[reportTest.id] ?? [];
          const rApprovedIds = new Set(
            rParts.filter((p) => (p.approval_status ?? 'approved') === 'approved').map((p) => p.student_id),
          );
          const rows = (attemptsByTest[reportTest.id] ?? [])
            .filter((a) => rParts.length === 0 || rApprovedIds.has(a.student_id))
            .slice()
            .sort((a, b) => a.prn.localeCompare(b.prn));
          const generatedAt = formatDateTimeIst(new Date().toISOString());
          const conductedAt = reportTest.conducted_at ? formatDateTimeIst(reportTest.conducted_at) : '—';
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '76vh', overflowY: 'auto' }}>
              <div style={{ fontSize: 12.5, padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                <div><strong>Course:</strong> {course.code} {course.title}</div>
                <div><strong>Assessment:</strong> {reportTest.topic} ({reportTest.test_code}) · CO: {reportTest.co_code || '—'}</div>
                <div><strong>Date of conduct:</strong> {conductedAt}</div>
                <div><strong>Report generated:</strong> {generatedAt}</div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Roll / PRN</th>
                    <th>Student name</th>
                    <th>Pre-test ({reportTest.pretest_marks})</th>
                    <th>Visible</th>
                    <th>Hidden</th>
                    <th>Coding final</th>
                    <th>Viva ({reportTest.viva_marks})</th>
                    <th>Total ({reportTest.total_marks})</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ansList = Object.values(r.answers ?? {});
                    const visSum = ansList.reduce((s, x) => s + Number(x.visible_marks_earned ?? 0), 0);
                    const hidSum = ansList.reduce((s, x) => s + Number(x.hidden_marks_earned ?? 0), 0);
                    const effCoding = r.coding_override_score ?? r.coding_score;
                    return (
                      <tr key={r.id}>
                        <td className="mono">{r.prn}</td>
                        <td>{r.student_name}</td>
                        <td className="mono">{r.pretest_score}</td>
                        <td className="mono">{visSum}</td>
                        <td className="mono">{hidSum}</td>
                        <td className="mono">{effCoding}</td>
                        <td className="mono">{r.viva_score}</td>
                        <td className="mono" style={{ fontWeight: 700 }}>{r.final_score}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
                <div>
                  <div><strong>Faculty signature:</strong> __________________________</div>
                  <div style={{ color: 'var(--muted)', marginTop: 4 }}>{profile?.full_name ?? 'Course Faculty'}</div>
                </div>
                <div className="no-print" style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setReportTest(null)}>
                    Close
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => window.print()}>
                    Print report
                  </button>
                </div>
              </div>
            </div>
          );
        })() : null}
      </Modal>
    </div>
  );
}
