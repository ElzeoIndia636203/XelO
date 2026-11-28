import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Banner, Card, Chip, Empty, Modal } from '../../../components/ui';
import { InstantTestPerformanceReport } from '../../../components/InstantTestPerformanceReport';
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
  references?: Record<string, string>;
  validated?: boolean;
  validation_note?: string;
  approved?: boolean;
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
  posttest_count?: number;
  posttest_marks?: number;
  viva_marks: number;
  scope_type: 'class' | 'batch' | 'students';
  status: 'scheduled' | 'active' | 'closed' | 'finalized';
  scheduled_at: string | null;
  conducted_at: string | null;
  allowed_langs: string[];
  questions?: Array<{
    id?: string;
    slot?: number;
    title: string;
    statement: string;
    difficulty: string;
    marks: number;
    co_code?: string;
    visible_marks?: number;
    hidden_marks?: number;
  }>;
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
  warning_count?: number;
  integrity_score?: number;
  reset_count?: number;
  auto_submitted_breach?: boolean;
  cheating_marked?: boolean;
  ended_reason?: string | null;
  last_heartbeat_at?: string | null;
  active_hold_rule?: string | null;
}

interface InstantProctorEventRow {
  id: string;
  instant_attempt_id: string | null;
  rule_id: string;
  level: string;
  detail: string;
  duration_sec: number;
  at: string;
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
  const { profile, institution } = useSession();
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
  const [posttestCount, setPosttestCount] = useState(0);
  const [posttestDifficulty, setPosttestDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [posttestMarks, setPosttestMarks] = useState(0);
  const [vivaMarks, setVivaMarks] = useState(0);
  const [slotDifficulties, setSlotDifficulties] = useState<Array<'easy' | 'medium' | 'hard' | 'mixed'>>(['medium', 'medium']);
  const [slotCoIds, setSlotCoIds] = useState<string[]>([outcomes[0]?.id ?? '', outcomes[0]?.id ?? '']);
  const [sameDurationPerQ, setSameDurationPerQ] = useState(true);
  const [totalDurationMinutes, setTotalDurationMinutes] = useState(60);
  const [slotDurations, setSlotDurations] = useState<number[]>([30, 30]);
  const [markMatrixApproved, setMarkMatrixApproved] = useState(false);

  const [scopeType, setScopeType] = useState<'class' | 'batch' | 'students'>('class');
  const [targetBatchIds, setTargetBatchIds] = useState<string[]>([]);
  const [targetStudentIds, setTargetStudentIds] = useState<string[]>([]);
  const [activateNow, setActivateNow] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [proctorLevel, setProctorLevel] = useState<1 | 2 | 3>(2);
  const [proctorCamera, setProctorCamera] = useState(false);
  const [proctorMic, setProctorMic] = useState(false);

  const [langs, setLangs] = useState<string[]>(() =>
    course.allowed_langs.length > 0 ? [...course.allowed_langs] : ['c', 'python'],
  );
  const [questions, setQuestions] = useState<InstantQuestionDraft[]>([]);
  const [activeSlot, setActiveSlot] = useState(1);
  const [activeVariant, setActiveVariant] = useState(1);
  const [activeRefLang, setActiveRefLang] = useState<string>('c');
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState('');

  const [tests, setTests] = useState<InstantTestRow[]>([]);
  const [attemptsByTest, setAttemptsByTest] = useState<Record<string, InstantAttemptRow[]>>({});
  const [participantsByTest, setParticipantsByTest] = useState<Record<string, InstantParticipantRow[]>>({});
  const [proctorEvents, setProctorEvents] = useState<InstantProctorEventRow[]>([]);
  const [viewMode, setViewMode] = useState<'dashboard' | 'create' | 'detail'>('dashboard');
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'monitor' | 'preview' | 'marks'>('monitor');
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
  const [departmentName, setDepartmentName] = useState('Computer Science and Engineering');

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('departments')
      .select('name')
      .eq('id', course.department_id)
      .maybeSingle<{ name: string }>()
      .then(({ data }) => {
        if (!cancelled && data?.name) setDepartmentName(data.name);
      });
    return () => {
      cancelled = true;
    };
  }, [course.department_id]);
  const [liveInspectAttemptId, setLiveInspectAttemptId] = useState<string | null>(null);
  const [liveInsightEvents, setLiveInsightEvents] = useState<InstantProctorEventRow[]>([]);
  const [liveInsightLoading, setLiveInsightLoading] = useState(false);

  const selectedCo = outcomes.find((o) => o.id === coId) ?? outcomes[0] ?? null;
  const getSlotCo = (slot: number) => {
    const id = questionCount > 1 ? (slotCoIds[slot - 1] ?? coId) : coId;
    return outcomes.find((o) => o.id === id) ?? selectedCo;
  };
  const studentMap = new Map(studentProfiles.map((p) => [p.id, p]));
  const targetStrength =
    scopeType === 'class'
      ? enrollments.length
      : scopeType === 'batch'
        ? enrollments.filter((e) => targetBatchIds.includes(e.batch_id)).length
        : targetStudentIds.length;
  const perBucketTarget = Math.max(
    questionCount,
    Math.ceil(Math.ceil(Math.max(1, targetStrength) * 0.5) / questionCount),
  );
  const bucketTarget = perBucketTarget * questionCount;
  const approveTarget = Math.max(questionCount, Math.ceil(Math.max(1, targetStrength) * 0.5));
  const approvedQuestions = questions.filter((q) => q.approved);
  const allSlotsHaveApproved = Array.from({ length: questionCount }, (_, idx) =>
    approvedQuestions.some((q) => q.slot === idx + 1),
  ).every(Boolean);
  const computedQuestionDurations = Array.from({ length: questionCount }, (_, idx) =>
    sameDurationPerQ
      ? Math.max(1, Math.round(totalDurationMinutes / Math.max(1, questionCount)))
      : Math.max(1, Number(slotDurations[idx] ?? 30)),
  );
  const computedTotalDuration = sameDurationPerQ
    ? Math.max(1, totalDurationMinutes)
    : computedQuestionDurations.reduce((a, b) => a + b, 0);
  const computedTotalMarks = Number(
    (
      (pretestCount > 0 ? pretestMarks : 0) +
      questionCount * (visibleMarks + hiddenMarks) +
      (posttestCount > 0 ? posttestMarks : 0) +
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

  async function generateAiBuckets(regenerateBalanceOnly = false) {
    if (!topic.trim()) {
      onNotify('Enter a topic before generating question buckets.', false);
      return;
    }
    if (visibleCount < 1 || hiddenCount < 1) {
      onNotify('At least 1 visible and 1 hidden test case are required.', false);
      return;
    }
    const existing = regenerateBalanceOnly ? [...questions] : [];
    const slotNeeds = Array.from({ length: questionCount }, (_, idx) => {
      const s = idx + 1;
      const inSlot = regenerateBalanceOnly ? existing.filter((q) => q.slot === s).length : 0;
      return Math.max(0, perBucketTarget - inSlot);
    });
    const needTotal = slotNeeds.reduce((a, b) => a + b, 0);
    if (needTotal <= 0) {
      onNotify(`All ${questionCount} buckets already have ${perBucketTarget} questions each.`, true);
      return;
    }

    setBusy(true);
    const perQMarks = Number((visibleMarks + hiddenMarks).toFixed(2));
    const allBuilt: InstantQuestionDraft[] = [...existing];
    const avoidTitles: string[] = existing.map((q) => q.title);

    try {
      let chunkCalls = 0;
      for (let slot = 1; slot <= questionCount; slot++) {
        const slotTarget = slotNeeds[slot - 1] ?? 0;
        if (slotTarget <= 0) continue;
        const slotDiff = questionCount > 1 ? (slotDifficulties[slot - 1] ?? difficulty) : difficulty;
        let slotBuilt = 0;

        while (slotBuilt < slotTarget) {
          if (chunkCalls > 0) {
            await new Promise((r) => setTimeout(r, 1200));
          }
          chunkCalls += 1;
          const chunk = Math.min(3, slotTarget - slotBuilt);
          setGenProgress(
            `Generating AI questions for Q${slot} (${allBuilt.length}/${bucketTarget} total)…`,
          );

          let res: {
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
              references?: Record<string, string>;
            }>;
          } | null = null;

          for (let retry = 0; retry < 3; retry++) {
            try {
              res = await fn<{
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
                  references?: Record<string, string>;
                }>;
              }>('ai-generate', {
                kind: 'instant_test_bucket',
                course_id: course.id,
                topic: topic.trim(),
                slot,
                bucket_size: chunk,
                difficulty: slotDiff,
                co_code: getSlotCo(slot)?.code ?? 'CO1',
                visible_count: visibleCount,
                hidden_count: hiddenCount,
                allowed_langs: langs,
                avoid_titles: avoidTitles,
              });
              break;
            } catch (callErr) {
              const msg = callErr instanceof Error ? callErr.message : String(callErr);
              if (msg.includes('429') && retry < 2) {
                const waitSec = 6 * (retry + 1);
                setGenProgress(`AI rate limited — waiting ${waitSec}s before retrying Q${slot} (${allBuilt.length}/${bucketTarget})…`);
                await new Promise((r) => setTimeout(r, waitSec * 1000));
                continue;
              }
              throw callErr;
            }
          }
          if (!res) break;

          const currentSlotCount = allBuilt.filter((q) => q.slot === slot).length;
          for (let vi = 0; vi < res.questions.length; vi++) {
            const item = res.questions[vi]!;
            avoidTitles.push(item.title);
            const vNum = currentSlotCount + vi + 1;
            allBuilt.push({
              id: `s${slot}_v${vNum}_${Date.now()}_${vi}`,
              slot,
              variant: vNum,
              title: item.title,
              statement: item.statement,
              input_spec: item.input_spec,
              output_spec: item.output_spec,
              constraints: item.constraints,
              sample_input: item.sample_input,
              sample_output: item.sample_output,
              difficulty: item.difficulty,
              marks: perQMarks,
              co_code: getSlotCo(slot)?.code ?? 'CO1',
              visible_marks: visibleMarks,
              hidden_marks: hiddenMarks,
              visible_tests: item.visible_tests,
              hidden_tests: item.hidden_tests,
              references: item.references ?? {},
              validated: false,
              approved: false,
            });
          }
          slotBuilt += res.questions.length;
          if (res.questions.length === 0) break;
        }
      }
      setQuestions(allBuilt);
      setActiveSlot(1);
      setActiveVariant(allBuilt.find((q) => q.slot === 1)?.variant ?? 1);
      onNotify(`Bucket updated: ${allBuilt.length}/${bucketTarget} questions (validate & approve to publish).`, true);
    } catch (err) {
      if (allBuilt.length > existing.length) {
        setQuestions(allBuilt);
        setActiveSlot(1);
        setActiveVariant(allBuilt.find((q) => q.slot === 1)?.variant ?? 1);
      }
      onNotify(errorMessage(err), false);
    } finally {
      setGenProgress('');
      setBusy(false);
    }
  }

  function addManualQuestion() {
    const perQMarks = Number((visibleMarks + hiddenMarks).toFixed(2));
    const slotCount = questions.filter((q) => q.slot === activeSlot).length;
    const nextVar = slotCount + 1;
    const diff = questionCount > 1 ? (slotDifficulties[activeSlot - 1] ?? difficulty) : difficulty;
    const q: InstantQuestionDraft = {
      id: `s${activeSlot}_m${nextVar}_${Date.now()}`,
      slot: activeSlot,
      variant: nextVar,
      title: `Manual Q${activeSlot}.${nextVar}`,
      statement: '',
      input_spec: '',
      output_spec: '',
      constraints: '',
      sample_input: '',
      sample_output: '',
      difficulty: diff === 'mixed' ? 'medium' : diff,
      marks: perQMarks,
      co_code: getSlotCo(activeSlot)?.code ?? 'CO1',
      visible_marks: visibleMarks,
      hidden_marks: hiddenMarks,
      visible_tests: Array.from({ length: visibleCount }, () => ({ input: '', expected: '' })),
      hidden_tests: Array.from({ length: hiddenCount }, () => ({ input: '', expected: '' })),
      references: {},
      validated: false,
      approved: false,
    };
    setQuestions((prev) => [...prev, q]);
    setActiveVariant(nextVar);
  }

  function parseCsvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell);
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  }

  function downloadExcelTemplate(targetSlot?: number) {
    const slotNum = targetSlot ?? activeSlot;
    const primaryLang = langs[0] ?? 'c';
    const headers = [
      'slot',
      'title',
      'statement',
      'difficulty',
      'co_code',
      'visible_input_1',
      'visible_expected_1',
      'hidden_input_1',
      'hidden_expected_1',
      `code_${primaryLang}`,
    ];
    const diff = questionCount > 1 ? (slotDifficulties[slotNum - 1] ?? difficulty) : difficulty;
    const sample = [
      String(slotNum),
      `Q${slotNum} Sample: Sum of Two Numbers`,
      'Given two integers A and B, print their sum.',
      diff === 'mixed' ? 'medium' : diff,
      getSlotCo(slotNum)?.code ?? 'CO1',
      '3 5',
      '8',
      '10 25',
      '35',
      primaryLang === 'python'
        ? 'a, b = map(int, input().split())\nprint(a + b)'
        : '#include <stdio.h>\nint main(){int a,b;if(scanf("%d %d",&a,&b)==2)printf("%d",a+b);return 0;}',
    ];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = `${headers.map(esc).join(',')}\n${sample.map(esc).join(',')}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = targetSlot ? `q${slotNum}_bucket_sample.csv` : 'instant_questions_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleUploadQuestions(file: File | null, targetSlot?: number) {
    if (!file) return;
    try {
      const perQMarks = Number((visibleMarks + hiddenMarks).toFixed(2));
      const lowerName = file.name.toLowerCase();
      let rawRows: Array<Array<unknown>> = [];

      if (lowerName.endsWith('.csv')) {
        rawRows = parseCsvRows(await file.text());
      } else {
        const { readSheet } = await import('read-excel-file/browser');
        rawRows = await readSheet(file);
      }

      if (rawRows.length < 2) {
        onNotify('Excel/CSV must have a header row and at least 1 question row.', false);
        return;
      }

      const headers = rawRows[0]!.map((h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_'));
      const dataRows = rawRows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
      if (dataRows.length === 0) {
        onNotify('No question rows found in the uploaded file.', false);
        return;
      }

      const getVal = (row: Array<unknown>, ...keys: string[]) => {
        for (const k of keys) {
          const idx = headers.indexOf(k);
          if (idx >= 0) {
            const v = String(row.at(idx) ?? '').trim();
            if (v !== '') return v;
          }
        }
        return '';
      };

      const built: InstantQuestionDraft[] = dataRows.map((row, idx) => {
        const slotRaw = Number(getVal(row, 'slot', 'q_no', 'question_no'));
        const slot = targetSlot
          ? targetSlot
          : Number.isInteger(slotRaw) && slotRaw >= 1 && slotRaw <= questionCount
            ? slotRaw
            : (idx % questionCount) + 1;
        const vNum = questions.filter((q) => q.slot === slot).length + idx + 1;

        const visible: InstantTestCase[] = [];
        for (let t = 1; t <= 10; t++) {
          const inp = getVal(row, `visible_input_${t}`, ...(t === 1 ? ['visible_input'] : []));
          const exp = getVal(row, `visible_expected_${t}`, `visible_output_${t}`, ...(t === 1 ? ['visible_expected', 'visible_output'] : []));
          if (inp || exp) visible.push({ input: inp, expected: exp });
        }
        const hidden: InstantTestCase[] = [];
        for (let t = 1; t <= 10; t++) {
          const inp = getVal(row, `hidden_input_${t}`, ...(t === 1 ? ['hidden_input'] : []));
          const exp = getVal(row, `hidden_expected_${t}`, `hidden_output_${t}`, ...(t === 1 ? ['hidden_expected', 'hidden_output'] : []));
          if (inp || exp) hidden.push({ input: inp, expected: exp });
        }

        const references: Record<string, string> = {};
        const genericCode = getVal(row, 'code', 'reference_code', 'solution');
        for (const l of langs) {
          const langCode = getVal(row, `code_${l}`, `reference_${l}`, l);
          if (langCode) references[l] = langCode;
          else if (genericCode && l === (langs[0] ?? 'c')) references[l] = genericCode;
        }

        const rawDiff = getVal(row, 'difficulty').toLowerCase();
        const diff: 'easy' | 'medium' | 'hard' =
          rawDiff === 'easy' || rawDiff === 'hard' ? rawDiff : 'medium';

        return {
          id: `up_${slot}_${vNum}_${Date.now()}_${idx}`,
          slot,
          variant: vNum,
          title: getVal(row, 'title', 'question_title') || `Uploaded Q${idx + 1}`,
          statement: getVal(row, 'statement', 'problem_statement', 'description'),
          input_spec: getVal(row, 'input_spec'),
          output_spec: getVal(row, 'output_spec'),
          constraints: getVal(row, 'constraints'),
          sample_input: visible[0]?.input ?? getVal(row, 'sample_input'),
          sample_output: visible[0]?.expected ?? getVal(row, 'sample_output'),
          difficulty: diff,
          marks: perQMarks,
          co_code: getVal(row, 'co_code', 'co') || (getSlotCo(slot)?.code ?? 'CO1'),
          visible_marks: visibleMarks,
          hidden_marks: hiddenMarks,
          visible_tests: visible.length >= 1 ? visible : [{ input: '1', expected: '1' }],
          hidden_tests: hidden.length >= 1 ? hidden : [{ input: '2', expected: '2' }],
          references,
          validated: false,
          approved: false,
        };
      });

      setQuestions((prev) => [...prev, ...built]);
      onNotify(`Uploaded ${built.length} question(s) from Excel/CSV. Validate & approve before publishing.`, true);
    } catch {
      onNotify('Could not read Excel/CSV file. Use the template format (.xlsx or .csv).', false);
    }
  }

  async function validateQuestionDraft(qId: string) {
    const q = questions.find((x) => x.id === qId);
    if (!q) return;
    if (!q.title.trim() || !q.statement.trim() || q.visible_tests.length < 1 || q.hidden_tests.length < 1) {
      onNotify('Question needs title, statement, and at least 1 visible + 1 hidden test case to validate.', false);
      return;
    }
    if (q.visible_tests.some((t) => !t.expected.trim()) || q.hidden_tests.some((t) => !t.expected.trim())) {
      onNotify('All visible and hidden test cases must have expected output.', false);
      return;
    }
    const refs = q.references ?? {};
    const missingLangs = langs.filter((l) => !refs[l]?.trim());
    if (missingLangs.length > 0) {
      onNotify(`Reference solution code is required for: ${missingLangs.join(', ')}`, false);
      return;
    }
    setValidatingId(qId);
    try {
      const res = await fn<{ valid: boolean; validation_note: string }>('validate-question', {
        draft: {
          course_id: course.id,
          allowed_langs: langs,
          visible_tests: q.visible_tests,
          hidden_tests: q.hidden_tests,
          references: refs,
        },
      });
      setQuestions((prev) =>
        prev.map((x) =>
          x.id === qId
            ? { ...x, validated: res.valid, validation_note: res.validation_note, approved: res.valid ? x.approved : false }
            : x,
        ),
      );
      onNotify(
        res.valid
          ? `Validated "${q.title}": ${res.validation_note}`
          : `Validation failed for "${q.title}": ${res.validation_note}`,
        res.valid,
      );
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setValidatingId(null);
    }
  }

  function approveQuestionDraft(qId: string) {
    const q = questions.find((x) => x.id === qId);
    if (!q?.validated) {
      onNotify('Validate the question first before approving.', false);
      return;
    }
    setQuestions((prev) => prev.map((x) => (x.id === qId ? { ...x, approved: true } : x)));
  }

  function discardQuestionDraft(qId: string) {
    setQuestions((prev) => prev.filter((x) => x.id !== qId));
  }

  async function publishTest(e: FormEvent) {
    e.preventDefault();
    if (!markMatrixApproved) {
      onNotify('Approve the Mark Allocation Matrix before publishing.', false);
      return;
    }
    if (!topic.trim() || approvedQuestions.length < approveTarget || !allSlotsHaveApproved) {
      onNotify(`Validate and approve at least 1 question from every bucket (${approveTarget} total) before saving.`, false);
      return;
    }
    if (visibleCount < 1 || hiddenCount < 1 || approvedQuestions.some((q) => q.visible_tests.length < 1 || q.hidden_tests.length < 1)) {
      onNotify('Every approved question must have at least 1 visible and 1 hidden test case.', false);
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
        p_questions: approvedQuestions,
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
        p_posttest_count: posttestCount,
        p_posttest_difficulty: posttestDifficulty,
        p_posttest_marks: posttestCount > 0 ? posttestMarks : 0,
        p_mark_matrix_approved: markMatrixApproved,
        p_same_duration_per_q: sameDurationPerQ,
        p_total_duration_minutes: computedTotalDuration,
        p_question_durations: computedQuestionDurations,
      });
      await rpc('faculty_set_proctor_config', {
        p_assessment_type: 'instant',
        p_assessment_id: res.id,
        p_level: proctorLevel,
        p_camera: proctorLevel === 3 ? true : proctorLevel === 2 ? proctorCamera : false,
        p_microphone: proctorLevel === 3 ? true : proctorLevel === 2 ? proctorMic : false,
        p_reason: '',
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
      setSelectedTestId(res.id);
      setViewMode('detail');
      setDetailTab('monitor');
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

  async function resetAttempt(attemptId: string, prn: string) {
    const reason = window.prompt(`Reason to reset attempt for ${prn} (max 2 resets allowed):`, 'Technical issue / allowed resume');
    if (reason === null) return;
    setBusy(true);
    try {
      const count = await rpc<number>('faculty_reset_instant_attempt', {
        p_attempt_id: attemptId,
        p_reason: reason.trim(),
      });
      onNotify(`Attempt reset for ${prn} (${count}/2 resets used).`, true);
      await reloadAll();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function markCheatingAndTerminate(attemptId: string, prn: string) {
    const reason = window.prompt(`Enter cheating / misconduct reason to terminate ${prn}'s test:`);
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await rpc('faculty_mark_cheating_and_terminate', {
        p_attempt_id: attemptId,
        p_reason: reason.trim(),
      });
      onNotify(`Terminated ${prn}'s attempt and recorded misconduct.`, true);
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

  const selectedTest = tests.find((t) => t.id === selectedTestId) ?? null;

  useEffect(() => {
    if (viewMode !== 'detail' || !selectedTest) return;
    const attIds = (attemptsByTest[selectedTest.id] ?? []).map((a) => a.id);
    let alive = true;
    const pullEvents = async () => {
      if (attIds.length === 0) {
        if (alive) setProctorEvents([]);
        return;
      }
      const { data } = await supabase
        .from('proctor_events')
        .select('id, instant_attempt_id, rule_id, level, detail, duration_sec, at')
        .in('instant_attempt_id', attIds)
        .order('at', { ascending: false })
        .limit(100);
      if (alive && data) setProctorEvents(data as InstantProctorEventRow[]);
    };
    const initTimer = window.setTimeout(() => void pullEvents(), 0);
    const timer = selectedTest.status === 'active'
      ? window.setInterval(() => {
          void pullEvents();
          void reloadAll();
        }, 15_000)
      : null;
    return () => {
      alive = false;
      window.clearTimeout(initTimer);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [viewMode, selectedTest, attemptsByTest, reloadAll]);

  // Fetch proctor events for the specific attempt open in Live Insights modal.
  // Refreshes every 10 s while the modal is open (live tests only).
  useEffect(() => {
    if (!liveInspectAttemptId) {
      return;
    }
    let alive = true;
    const pull = async () => {
      setLiveInsightLoading(true);
      const { data } = await supabase
        .from('proctor_events')
        .select('id, instant_attempt_id, rule_id, level, detail, duration_sec, at')
        .eq('instant_attempt_id', liveInspectAttemptId)
        .order('at', { ascending: false })
        .limit(200);
      if (alive) {
        setLiveInsightEvents((data as InstantProctorEventRow[]) ?? []);
        setLiveInsightLoading(false);
      }
    };
    void pull();
    const interval = window.setInterval(() => void pull(), 10_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [liveInspectAttemptId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {viewMode === 'dashboard' ? (
        <Card
          title="Instant coding test dashboard"
          actions={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setViewMode('create')}
            >
              + Create new test
            </button>
          }
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 14, fontSize: 13 }}>
            <Chip tone="neutral">{tests.length} total tests</Chip>
            <Chip tone="good">{tests.filter((t) => t.status === 'active').length} live now</Chip>
            <Chip tone="warn">{tests.filter((t) => t.status === 'scheduled').length} scheduled</Chip>
            <Chip tone="neutral">{tests.filter((t) => t.status === 'finalized').length} completed</Chip>
          </div>
          {tests.length === 0 ? (
            <Empty
              title="No instant coding tests yet"
              body='Click "+ Create new test" to set rubrics, proctoring level, target students, and questions.'
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tests.map((t) => {
                const tAtts = attemptsByTest[t.id] ?? [];
                return (
                  <div
                    key={t.id}
                    style={{
                      padding: 12,
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 10,
                    }}
                  >
                    <div>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700, padding: '2px 8px', background: '#DCEBE6', color: '#0E5E52', borderRadius: 4, marginRight: 8 }}>
                        {t.test_code}
                      </span>
                      <strong>{t.topic}</strong> · {t.question_count} Qs · {t.total_marks} marks · {tAtts.length} attempt(s)
                      {t.scheduled_at ? ` · ${formatDateTimeIst(t.scheduled_at)}` : ''}
                    </div>
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip tone={t.status === 'active' ? 'good' : t.status === 'scheduled' ? 'warn' : 'neutral'}>
                        {t.status}
                      </Chip>
                      <button
                        type="button"
                        className="btn btn-primary field-sm"
                        onClick={() => {
                          setSelectedTestId(t.id);
                          setDetailTab('monitor');
                          setViewMode('detail');
                        }}
                      >
                        Live monitor & logs
                      </button>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() => {
                          setSelectedTestId(t.id);
                          setDetailTab('preview');
                          setViewMode('detail');
                        }}
                      >
                        Preview
                      </button>
                      <button type="button" className="btn field-sm" onClick={() => setReportTest(t)}>
                        Report
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}

      {viewMode === 'detail' && selectedTest ? (() => {
        const dParts = participantsByTest[selectedTest.id] ?? [];
        const dApprovedIds = new Set(
          dParts.filter((p) => (p.approval_status ?? 'approved') === 'approved').map((p) => p.student_id),
        );
        const dAtts = (attemptsByTest[selectedTest.id] ?? [])
          .filter((a) => dParts.length === 0 || dApprovedIds.has(a.student_id))
          .slice()
          .sort((a, b) => a.prn.localeCompare(b.prn));
        const attMap = new Map(dAtts.map((a) => [a.id, a]));
        return (
          <Card
            title={`${selectedTest.topic} (${selectedTest.test_code})`}
            actions={
              <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn field-sm" onClick={() => setViewMode('dashboard')}>
                  ← Back to dashboard
                </button>
                <button type="button" className="btn field-sm" onClick={() => setReportTest(selectedTest)}>
                  Performance report
                </button>
              </div>
            }
          >
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={detailTab === 'monitor' ? 'btn btn-primary field-sm' : 'btn field-sm'}
                onClick={() => setDetailTab('monitor')}
              >
                Live monitor & event log ({dAtts.length})
              </button>
              <button
                type="button"
                className={detailTab === 'preview' ? 'btn btn-primary field-sm' : 'btn field-sm'}
                onClick={() => setDetailTab('preview')}
              >
                Preview questions & rubric
              </button>
              <button
                type="button"
                className={detailTab === 'marks' ? 'btn btn-primary field-sm' : 'btn field-sm'}
                onClick={() => setDetailTab('marks')}
              >
                Marks & inspection
              </button>
            </div>

            {detailTab === 'monitor' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  2nd proctor breach auto-submits the attempt · Faculty may reset up to <strong>2 times</strong> per student · Marking cheating terminates immediately.
                </div>
                {dAtts.length === 0 ? (
                  <Empty title="No active attempts yet" body="Students will appear here as soon as they start the test." />
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                    <thead>
                      <tr>
                        <th>PRN</th>
                        <th>Student</th>
                        <th>State</th>
                        <th>Breaches</th>
                        <th>Integrity</th>
                        <th>Resets</th>
                        <th style={{ textAlign: 'right' }}>Live actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dAtts.map((a) => {
                        const stateLabel = a.cheating_marked
                          ? 'Terminated (Cheating)'
                          : a.auto_submitted_breach
                            ? 'Auto-submitted (2nd breach)'
                            : a.submitted_at
                              ? 'Submitted'
                              : 'Live';
                        const resets = a.reset_count ?? 0;
                        return (
                          <tr key={a.id}>
                            <td className="mono">{a.prn}</td>
                            <td>
                              <button
                                type="button"
                                onClick={() => setLiveInspectAttemptId(a.id)}
                                style={{
                                  background: 'none',
                                  border: 0,
                                  padding: 0,
                                  color: 'var(--accent)',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                  textAlign: 'left',
                                }}
                              >
                                {a.student_name}
                              </button>
                            </td>
                            <td>
                              <Chip tone={a.cheating_marked || a.auto_submitted_breach ? 'bad' : a.submitted_at ? 'good' : 'warn'}>
                                {stateLabel}
                              </Chip>
                            </td>
                            <td className="mono">{a.warning_count ?? 0}/2</td>
                            <td className="mono">{Math.round(a.integrity_score ?? 100)}/100</td>
                            <td className="mono">{resets}/2</td>
                            <td style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn field-sm"
                                onClick={() => setLiveInspectAttemptId(a.id)}
                              >
                                Live insights
                              </button>
                              <button
                                type="button"
                                className="btn field-sm"
                                disabled={busy || resets >= 2 || Boolean(a.cheating_marked)}
                                onClick={() => void resetAttempt(a.id, a.prn)}
                              >
                                Reset ({resets}/2)
                              </button>
                              <button
                                type="button"
                                className="btn field-sm"
                                disabled={busy || Boolean(a.cheating_marked)}
                                onClick={() => void markCheatingAndTerminate(a.id, a.prn)}
                              >
                                Mark cheating & terminate
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    </table>
                  </div>
                )}

                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    Event log ({proctorEvents.length})
                  </div>
                  {proctorEvents.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No proctor events recorded yet.</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>PRN</th>
                          <th>Rule</th>
                          <th>Level</th>
                          <th>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proctorEvents.map((ev) => {
                          const att = ev.instant_attempt_id ? attMap.get(ev.instant_attempt_id) : undefined;
                          return (
                            <tr key={ev.id}>
                              <td className="mono">{formatDateTimeIst(ev.at)}</td>
                              <td className="mono">{att?.prn ?? '—'}</td>
                              <td className="mono">{ev.rule_id}</td>
                              <td><Chip tone={ev.level === 'S2' || ev.level === 'S3' ? 'bad' : ev.level === 'S1' ? 'warn' : 'neutral'}>{ev.level}</Chip></td>
                              <td>{ev.detail}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {detailTab === 'preview' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <div>
                  <strong>Rubric:</strong> {selectedTest.question_count} Qs · {selectedTest.total_marks} total marks
                  (Pre-test {selectedTest.pretest_marks}, Viva {selectedTest.viva_marks}) · CO {selectedTest.co_code || '—'}
                </div>
                {(selectedTest.questions ?? []).map((q, idx) => (
                  <div key={q.id ?? idx} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
                    <div style={{ fontWeight: 600 }}>#{idx + 1} · {q.title} ({q.difficulty}, {q.marks} marks)</div>
                    <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{q.statement}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {detailTab === 'marks' ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Use the main test list below or click <strong>Performance report</strong> above to inspect code, override marks (decrease-only), and submit final marks.
              </div>
            ) : null}
          </Card>
        );
      })() : null}

      {viewMode === 'create' ? (
      <Card
        title="Schedule or create instant coding test"
        actions={
          <button type="button" className="btn field-sm" onClick={() => setViewMode('dashboard')}>
            ← Back to dashboard
          </button>
        }
      >
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
                onChange={(e) => {
                  const next = Math.max(1, Number(e.target.value));
                  setQuestionCount(next);
                  setMarkMatrixApproved(false);
                }}
              />
            </label>
            {questionCount === 1 ? (
              <>
                <label className="field-label">
                  Coding difficulty
                  <select
                    className="field"
                    value={difficulty}
                    onChange={(e) => {
                      const val = e.target.value as 'easy' | 'medium' | 'hard' | 'mixed';
                      setDifficulty(val);
                      setSlotDifficulties((prev) => {
                        const next = [...prev];
                        next[0] = val;
                        return next;
                      });
                      setMarkMatrixApproved(false);
                    }}
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
              </>
            ) : null}
          </div>

          {questionCount > 1 ? (
            <div style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Individual question difficulty & CO mapping ({questionCount} questions)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {Array.from({ length: questionCount }, (_, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <label className="field-label">
                      Q{idx + 1} difficulty
                      <select
                        className="field field-sm"
                        value={slotDifficulties[idx] ?? difficulty}
                        onChange={(e) => {
                          const val = e.target.value as 'easy' | 'medium' | 'hard' | 'mixed';
                          setSlotDifficulties((prev) => {
                            const next = Array.from({ length: questionCount }, (_, i) => prev[i] ?? difficulty);
                            next[idx] = val;
                            return next;
                          });
                          setMarkMatrixApproved(false);
                        }}
                      >
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                        <option value="mixed">Mixed</option>
                      </select>
                    </label>
                    <label className="field-label">
                      Q{idx + 1} CO
                      <select
                        className="field field-sm"
                        value={getSlotCo(idx + 1)?.id ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSlotCoIds((prev) => {
                            const next = Array.from({ length: questionCount }, (_, i) => prev[i] ?? (selectedCo?.id ?? ''));
                            next[idx] = val;
                            return next;
                          });
                          setMarkMatrixApproved(false);
                        }}
                      >
                        {outcomes.length === 0 ? <option value="">None</option> : null}
                        {outcomes.map((co) => (
                          <option key={co.id} value={co.id}>
                            {co.code} (L{co.btl})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              Rubric & weightage (Total: {computedTotalMarks} marks · Pre-test, Post-lab & Viva can be 0; ≥1 visible & ≥1 hidden test mandatory)
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
                  onChange={(e) => {
                    setVisibleCount(Math.max(1, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    setVisibleMarks(Math.max(0, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    setHiddenCount(Math.max(1, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    setHiddenMarks(Math.max(0, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    syncPretestSlots(Math.min(20, Math.max(0, Math.trunc(Number(e.target.value) || 0))));
                    setMarkMatrixApproved(false);
                  }}
                />
              </label>
              <label className="field-label">
                Pre-test difficulty
                <select
                  className="field"
                  disabled={pretestCount === 0}
                  value={pretestDifficulty}
                  onChange={(e) => {
                    setPretestDifficulty(e.target.value as 'easy' | 'medium' | 'hard' | 'mixed');
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    setPretestMarks(Math.max(0, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
                />
              </label>
              <label className="field-label">
                Post-lab test MCQs (0 = none)
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  max={20}
                  value={posttestCount}
                  onChange={(e) => {
                    setPosttestCount(Math.min(20, Math.max(0, Math.trunc(Number(e.target.value) || 0))));
                    setMarkMatrixApproved(false);
                  }}
                />
              </label>
              <label className="field-label">
                Post-lab difficulty
                <select
                  className="field"
                  disabled={posttestCount === 0}
                  value={posttestDifficulty}
                  onChange={(e) => {
                    setPosttestDifficulty(e.target.value as 'easy' | 'medium' | 'hard' | 'mixed');
                    setMarkMatrixApproved(false);
                  }}
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label className="field-label">
                Post-lab marks (0 = none)
                <input
                  className="field mono"
                  type="number"
                  min={0}
                  step="0.5"
                  disabled={posttestCount === 0}
                  value={posttestCount === 0 ? 0 : posttestMarks}
                  onChange={(e) => {
                    setPosttestMarks(Math.max(0, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
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
                  onChange={(e) => {
                    setVivaMarks(Math.max(0, Number(e.target.value)));
                    setMarkMatrixApproved(false);
                  }}
                />
              </label>
            </div>

            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Mark allocation matrix (approve before fixing proctoring level)</div>
                {markMatrixApproved ? (
                  <span className="chip chip-ok">Mark matrix approved</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary field-sm"
                    onClick={() => setMarkMatrixApproved(true)}
                  >
                    Approve mark allocation matrix
                  </button>
                )}
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th>Details</th>
                      <th className="mono">Marks</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Pre-test</td>
                      <td>{pretestCount > 0 ? `${pretestCount} MCQs (${pretestDifficulty})` : 'None'}</td>
                      <td className="mono">{pretestCount > 0 ? pretestMarks : 0}</td>
                    </tr>
                    {Array.from({ length: questionCount }, (_, idx) => (
                      <tr key={idx}>
                        <td>Coding Q{idx + 1}</td>
                        <td>
                          {getSlotCo(idx + 1)?.code ?? 'CO1'} · {slotDifficulties[idx] ?? difficulty} · {visibleCount} visible ({visibleMarks}m) + {hiddenCount} hidden ({hiddenMarks}m)
                        </td>
                        <td className="mono">{visibleMarks + hiddenMarks}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>Post-lab test</td>
                      <td>{posttestCount > 0 ? `${posttestCount} MCQs (${posttestDifficulty})` : 'None'}</td>
                      <td className="mono">{posttestCount > 0 ? posttestMarks : 0}</td>
                    </tr>
                    <tr>
                      <td>Viva</td>
                      <td>{vivaMarks > 0 ? 'Faculty oral evaluation' : 'None'}</td>
                      <td className="mono">{vivaMarks}</td>
                    </tr>
                    <tr style={{ fontWeight: 700, background: 'var(--surface)' }}>
                      <td>Grand total</td>
                      <td>{questionCount} coding Qs + assessments</td>
                      <td className="mono">{computedTotalMarks}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                Time duration (Total: {computedTotalDuration} min)
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="duration-mode"
                    checked={sameDurationPerQ}
                    onChange={() => setSameDurationPerQ(true)}
                  />
                  Same time duration for all Qs
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="duration-mode"
                    checked={!sameDurationPerQ}
                    onChange={() => setSameDurationPerQ(false)}
                  />
                  Question-wise time duration
                </label>
              </div>
            </div>
            {sameDurationPerQ ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="field-label">
                  Total time duration (minutes)
                  <input
                    className="field field-sm mono"
                    type="number"
                    min={1}
                    max={300}
                    value={totalDurationMinutes}
                    onChange={(e) => setTotalDurationMinutes(Math.max(1, Number(e.target.value) || 1))}
                    style={{ width: 130 }}
                  />
                </label>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14 }}>
                  ~{Math.max(1, Math.round(totalDurationMinutes / Math.max(1, questionCount)))} min per question (auto-submits on expiry)
                </span>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8 }}>
                {Array.from({ length: questionCount }, (_, idx) => (
                  <label key={idx} className="field-label">
                    Q{idx + 1} duration (min)
                    <input
                      className="field field-sm mono"
                      type="number"
                      min={1}
                      max={180}
                      value={slotDurations[idx] ?? 30}
                      onChange={(e) => {
                        const val = Math.max(1, Number(e.target.value) || 1);
                        setSlotDurations((prev) => {
                          const next = Array.from({ length: questionCount }, (_, i) => prev[i] ?? 30);
                          next[idx] = val;
                          return next;
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

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

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <label className="field-label">
                Proctoring level
                <select
                  className="field field-sm"
                  disabled={!markMatrixApproved}
                  value={proctorLevel}
                  onChange={(e) => {
                    const lvl = Number(e.target.value) as 1 | 2 | 3;
                    setProctorLevel(lvl);
                    if (lvl === 3) {
                      setProctorCamera(true);
                      setProctorMic(true);
                    } else if (lvl === 1) {
                      setProctorCamera(false);
                      setProctorMic(false);
                    }
                  }}
                >
                  <option value={2}>Level 2 · Moderate (Default)</option>
                  <option value={1}>Level 1 · Minimum (Lockdown only)</option>
                  <option value={3}>Level 3 · High (Cam + Mic + Screen)</option>
                </select>
              </label>
              {proctorLevel === 2 ? (
                <>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 14 }}>
                    <input type="checkbox" disabled={!markMatrixApproved} checked={proctorCamera} onChange={(e) => setProctorCamera(e.target.checked)} />
                    Camera + AI rules
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 14 }}>
                    <input type="checkbox" disabled={!markMatrixApproved} checked={proctorMic} onChange={(e) => setProctorMic(e.target.checked)} />
                    Microphone + audio rules
                  </label>
                </>
              ) : null}
              <span className="mono" style={{ fontSize: 11.5, color: !markMatrixApproved ? 'var(--danger)' : 'var(--muted)', marginTop: 14 }}>
                {!markMatrixApproved
                  ? 'Approve mark allocation matrix above before setting proctoring level'
                  : proctorLevel === 3
                    ? 'Camera, mic & entire-screen share required'
                    : proctorLevel === 2
                      ? 'Entire-screen share & lockdown required; camera/mic optional'
                      : 'Browser lockdown & code checks only'}
              </span>
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
            <button type="button" className="btn" disabled={busy} onClick={() => void generateAiBuckets(false)}>
              {genProgress || `Generate ${bucketTarget} AI questions (${questionCount} buckets × ${perBucketTarget} each)`}
            </button>
            {questions.length > 0 && questions.length < bucketTarget ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void generateAiBuckets(true)}>
                Regenerate balance ({bucketTarget - questions.length})
              </button>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={addManualQuestion}>
              + Add manual question
            </button>
            <label className="btn" style={{ cursor: 'pointer', margin: 0 }}>
              Upload Excel
              <input
                type="file"
                accept=".xlsx,.csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUploadQuestions(file);
                  e.target.value = '';
                }}
              />
            </label>
            <button type="button" className="btn" onClick={() => downloadExcelTemplate()}>
              Excel template
            </button>
            <span className={approvedQuestions.length >= approveTarget && allSlotsHaveApproved ? 'chip chip-ok' : 'chip'}>
              Approved: {approvedQuestions.length}/{approveTarget}
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !markMatrixApproved || approvedQuestions.length < approveTarget || !allSlotsHaveApproved}
            >
              {busy && !genProgress ? 'Saving…' : activateNow ? 'Publish & activate now' : 'Schedule test & notify students'}
            </button>
          </div>

          {(() => {
            const slotQs = questions.filter((x) => x.slot === activeSlot);
            const activeQ = slotQs.find((x) => x.variant === activeVariant) ?? slotQs[0] ?? null;
            const updateQ = (patch: Partial<InstantQuestionDraft>) => {
              if (!activeQ) return;
              setQuestions((prev) => prev.map((x) => (x.id === activeQ.id ? { ...x, ...patch } : x)));
            };
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {Array.from({ length: questionCount }, (_, idx) => idx + 1).map((s) => {
                    const slotCount = questions.filter((x) => x.slot === s).length;
                    const slotApproved = questions.filter((x) => x.slot === s && x.approved).length;
                    return (
                      <button
                        key={s}
                        type="button"
                        className={activeSlot === s ? 'btn btn-primary field-sm' : 'btn field-sm'}
                        onClick={() => {
                          setActiveSlot(s);
                          setActiveVariant(1);
                        }}
                      >
                        Q{s} Bucket ({slotApproved}/{slotCount})
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="btn field-sm"
                    onClick={() => downloadExcelTemplate(activeSlot)}
                  >
                    Download Q{activeSlot} sample
                  </button>
                  <label className="btn field-sm" style={{ cursor: 'pointer', margin: 0 }}>
                    Upload Q{activeSlot} Excel
                    <input
                      type="file"
                      accept=".xlsx,.csv"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleUploadQuestions(file, activeSlot);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {activeQ ? (
                    <>
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>Variant:</span>
                      <select
                        className="field field-sm"
                        value={activeQ.variant}
                        onChange={(e) => setActiveVariant(Number(e.target.value))}
                        style={{ width: 110 }}
                      >
                        {slotQs.map((v) => (
                          <option key={v.id} value={v.variant}>
                            #{v.variant} {v.approved ? '✓' : v.validated ? '•' : ''}
                          </option>
                        ))}
                      </select>
                      <span className={activeQ.approved ? 'chip chip-ok' : activeQ.validated ? 'chip' : 'chip chip-warn'}>
                        {activeQ.approved ? 'Approved' : activeQ.validated ? 'Validated' : 'Needs validation'}
                      </span>
                    </>
                  ) : null}
                </div>
                {!activeQ ? (
                  <div className="muted" style={{ fontSize: 12.5, padding: 10, border: '1px dashed var(--border)', borderRadius: 6 }}>
                    No questions in Q{activeSlot} Bucket yet. Click Regenerate balance or + Add manual question.
                  </div>
                ) : (
                <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <input
                      className="field field-sm"
                      value={activeQ.title}
                      onChange={(e) => updateQ({ title: e.target.value, validated: false, approved: false })}
                      style={{ fontWeight: 600, flex: '1 1 240px' }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn field-sm"
                        disabled={validatingId === activeQ.id}
                        onClick={() => void validateQuestionDraft(activeQ.id)}
                      >
                        {validatingId === activeQ.id ? 'Validating…' : 'Validate'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary field-sm"
                        disabled={!activeQ.validated || Boolean(activeQ.approved)}
                        onClick={() => approveQuestionDraft(activeQ.id)}
                      >
                        {activeQ.approved ? 'Approved' : 'Approve'}
                      </button>
                      <button type="button" className="btn field-sm" onClick={() => discardQuestionDraft(activeQ.id)}>
                        Discard
                      </button>
                    </div>
                  </div>
                  {activeQ.validation_note ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        padding: '6px 8px',
                        borderRadius: 4,
                        background: activeQ.validated ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        color: activeQ.validated ? 'var(--ok)' : 'var(--danger)',
                      }}
                    >
                      {activeQ.validation_note}
                    </div>
                  ) : null}
                  <textarea
                    className="field"
                    rows={3}
                    value={activeQ.statement}
                    onChange={(e) => updateQ({ statement: e.target.value, validated: false, approved: false })}
                    style={{ height: 'auto', padding: 8 }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Visible test cases ({activeQ.visible_tests.length})</div>
                      {activeQ.visible_tests.map((tc, ti) => (
                        <div key={ti} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                          <textarea
                            className="field mono"
                            rows={2}
                            placeholder={`Visible #${ti + 1} stdin`}
                            value={tc.input}
                            onChange={(e) => {
                              const next = activeQ.visible_tests.map((x, xi) => (xi === ti ? { ...x, input: e.target.value } : x));
                              updateQ({ visible_tests: next, validated: false, approved: false });
                            }}
                            style={{ height: 'auto', padding: 6, fontSize: 11.5 }}
                          />
                          <textarea
                            className="field mono"
                            rows={2}
                            placeholder={`Visible #${ti + 1} expected`}
                            value={tc.expected}
                            onChange={(e) => {
                              const next = activeQ.visible_tests.map((x, xi) => (xi === ti ? { ...x, expected: e.target.value } : x));
                              updateQ({ visible_tests: next, validated: false, approved: false });
                            }}
                            style={{ height: 'auto', padding: 6, fontSize: 11.5 }}
                          />
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Hidden test cases ({activeQ.hidden_tests.length})</div>
                      {activeQ.hidden_tests.map((tc, ti) => (
                        <div key={ti} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                          <textarea
                            className="field mono"
                            rows={2}
                            placeholder={`Hidden #${ti + 1} stdin`}
                            value={tc.input}
                            onChange={(e) => {
                              const next = activeQ.hidden_tests.map((x, xi) => (xi === ti ? { ...x, input: e.target.value } : x));
                              updateQ({ hidden_tests: next, validated: false, approved: false });
                            }}
                            style={{ height: 'auto', padding: 6, fontSize: 11.5 }}
                          />
                          <textarea
                            className="field mono"
                            rows={2}
                            placeholder={`Hidden #${ti + 1} expected`}
                            value={tc.expected}
                            onChange={(e) => {
                              const next = activeQ.hidden_tests.map((x, xi) => (xi === ti ? { ...x, expected: e.target.value } : x));
                              updateQ({ hidden_tests: next, validated: false, approved: false });
                            }}
                            style={{ height: 'auto', padding: 6, fontSize: 11.5 }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>Reference solution code</span>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {langs.map((l) => {
                          const selectedRefLang = langs.includes(activeRefLang) ? activeRefLang : (langs[0] ?? 'c');
                          return (
                            <button
                              key={l}
                              type="button"
                              className={selectedRefLang === l ? 'btn btn-primary field-sm' : 'btn field-sm'}
                              onClick={() => setActiveRefLang(l)}
                            >
                              {l.toUpperCase()}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {(() => {
                      const selectedRefLang = langs.includes(activeRefLang) ? activeRefLang : (langs[0] ?? 'c');
                      return (
                        <textarea
                          className="field mono"
                          rows={6}
                          placeholder={`Enter ${selectedRefLang.toUpperCase()} reference solution (reads stdin, prints stdout)`}
                          value={activeQ.references?.[selectedRefLang] ?? ''}
                          onChange={(e) =>
                            updateQ({
                              references: { ...(activeQ.references ?? {}), [selectedRefLang]: e.target.value },
                              validated: false,
                              approved: false,
                            })
                          }
                          style={{ height: 'auto', padding: 8, fontSize: 12 }}
                        />
                      );
                    })()}
                  </div>
                </div>
                )}
              </div>
            );
          })()}
        </form>
      </Card>
      ) : null}

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
                    <div style={{ overflowX: 'auto', marginTop: 10 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>PRN</th>
                            <th>Name</th>
                            <th style={{ whiteSpace: 'nowrap' }}>Pre-test</th>
                            <th style={{ whiteSpace: 'nowrap' }}>Coding</th>
                            <th style={{ whiteSpace: 'nowrap' }}>Override</th>
                            <th style={{ whiteSpace: 'nowrap' }}>Viva</th>
                            <th style={{ whiteSpace: 'nowrap' }}>Total</th>
                            <th>Status</th>
                            <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {attempts.map((a) => (
                            <tr key={a.id}>
                              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.prn}</td>
                              <td>{a.student_name}</td>
                              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.pretest_score} / {t.pretest_marks}</td>
                              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.coding_score}</td>
                              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.coding_override_score ?? '—'}</td>
                              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{a.viva_score} / {t.viva_marks}</td>
                              <td className="mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {a.final_score} / {t.total_marks}
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <Chip tone={a.marks_approved ? 'good' : a.code_approved ? 'neutral' : 'warn'}>
                                  {a.marks_approved ? 'Approved' : a.code_approved ? 'Code ok' : 'Pending'}
                                </Chip>
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                    </div>
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

      {liveInspectAttemptId && selectedTest ? (() => {
        const liveAtt = (attemptsByTest[selectedTest.id] ?? []).find((x) => x.id === liveInspectAttemptId) ?? null;
        if (!liveAtt) return null;
        const breaches = liveInsightEvents.filter((ev) => ev.level === 'S1' || ev.level === 'S2' || ev.level === 'S3');
        const ansEntries = Object.entries(liveAtt.answers ?? {});
        const resets = liveAtt.reset_count ?? 0;
        const refreshLiveInsights = async () => {
          void fetchTests();
          setLiveInsightLoading(true);
          const { data } = await supabase
            .from('proctor_events')
            .select('id, instant_attempt_id, rule_id, level, detail, duration_sec, at')
            .eq('instant_attempt_id', liveAtt.id)
            .order('at', { ascending: false })
            .limit(200);
          setLiveInsightEvents((data as InstantProctorEventRow[]) ?? []);
          setLiveInsightLoading(false);
        };
        return (
          <Modal
            open
            title={`Live insights · ${liveAtt.student_name} (${liveAtt.prn})`}
            onClose={() => {
              setLiveInspectAttemptId(null);
              setLiveInsightEvents([]);
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '76vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Chip tone={liveAtt.cheating_marked || liveAtt.auto_submitted_breach ? 'bad' : liveAtt.submitted_at ? 'good' : 'warn'}>
                  {liveAtt.cheating_marked
                    ? 'Terminated (Cheating)'
                    : liveAtt.auto_submitted_breach
                      ? 'Auto-submitted (2nd breach)'
                      : liveAtt.submitted_at
                        ? 'Submitted'
                        : 'Live'}
                </Chip>
                <Chip tone={(liveAtt.warning_count ?? 0) > 0 || breaches.length > 0 ? 'warn' : 'good'}>
                  Breaches: {liveAtt.warning_count ?? 0}/2
                </Chip>
                <Chip tone="neutral">Integrity: {Math.round(liveAtt.integrity_score ?? 100)}/100</Chip>
                <Chip tone="neutral">Resets: {resets}/2</Chip>
                <Chip tone="neutral">Coding score: {liveAtt.coding_score}/{selectedTest.total_marks}</Chip>
                <button type="button" className="btn field-sm" disabled={liveInsightLoading} onClick={() => void refreshLiveInsights()}>
                  {liveInsightLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {breaches.length > 0 ? (
                <Banner tone="err">
                  {breaches.length} proctor breach{breaches.length === 1 ? '' : 'es'} detected ({breaches.map((b) => b.rule_id).join(', ')}).
                </Banner>
              ) : null}

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  Code typed & test cases passed ({ansEntries.length} question{ansEntries.length === 1 ? '' : 's'})
                </div>
                {ansEntries.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    No code typed or test runs recorded yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {ansEntries.map(([qid, ans], idx) => {
                      const qMeta = (selectedTest.questions ?? []).find((q) => q.id === qid);
                      return (
                        <div key={qid} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            <strong style={{ fontSize: 13 }}>
                              Q{idx + 1}: {qMeta?.title ?? qid}
                            </strong>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <Chip tone="neutral">{(ans.lang ?? 'c').toUpperCase()}</Chip>
                              <Chip tone={(ans.visible_passed ?? 0) > 0 ? 'good' : 'neutral'}>
                                Visible: {ans.visible_passed ?? 0}/{ans.visible_total ?? selectedTest.visible_count}
                              </Chip>
                              <Chip tone={(ans.hidden_passed ?? 0) > 0 ? 'good' : 'neutral'}>
                                Hidden: {ans.hidden_passed ?? 0}/{ans.hidden_total ?? selectedTest.hidden_count}
                              </Chip>
                              <Chip tone="neutral">Marks: {ans.marks_awarded ?? 0}</Chip>
                            </div>
                          </div>
                          <pre
                            className="mono"
                            style={{
                              margin: 0,
                              padding: 10,
                              borderRadius: 6,
                              background: '#141413',
                              color: '#E8E6DF',
                              fontSize: 12,
                              maxHeight: 220,
                              overflow: 'auto',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {ans.code?.trim() ? ans.code : '// No code typed yet'}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  Student proctor log & breaches ({liveInsightEvents.length})
                </div>
                {liveInsightLoading && liveInsightEvents.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading proctor events…</div>
                ) : liveInsightEvents.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No proctor events logged for this student.</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Rule</th>
                        <th>Level</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveInsightEvents.map((ev) => (
                        <tr key={ev.id}>
                          <td className="mono">{formatDateTimeIst(ev.at)}</td>
                          <td className="mono">{ev.rule_id}</td>
                          <td><Chip tone={ev.level === 'S2' || ev.level === 'S3' ? 'bad' : ev.level === 'S1' ? 'warn' : 'neutral'}>{ev.level}</Chip></td>
                          <td>{ev.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busy || resets >= 2 || Boolean(liveAtt.cheating_marked)}
                  onClick={() => void resetAttempt(liveAtt.id, liveAtt.prn)}
                >
                  Reset ({resets}/2)
                </button>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busy || Boolean(liveAtt.cheating_marked)}
                  onClick={() => void markCheatingAndTerminate(liveAtt.id, liveAtt.prn)}
                >
                  Mark cheating & terminate
                </button>
                <button type="button" className="btn btn-primary field-sm" onClick={() => setLiveInspectAttemptId(null)}>
                  Close
                </button>
              </div>
            </div>
          </Modal>
        );
      })() : null}

      <Modal
        open={reportTest !== null}
        title={reportTest ? `Performance report · ${reportTest.topic}` : 'Performance report'}
        onClose={() => setReportTest(null)}
        printable
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
          const facultyName = profile?.full_name ?? 'Course Faculty';
          const universityName = institution?.name ?? 'University';
          return (
            <div className="printable-report-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '76vh', overflowY: 'auto' }}>
              <InstantTestPerformanceReport
                universityName={universityName}
                departmentName={departmentName}
                facultyName={facultyName}
                course={course}
                test={reportTest}
                outcomes={outcomes}
                institution={institution}
                attempts={rows}
                conductedAt={conductedAt}
                generatedAt={generatedAt}
              />
              <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
                <button type="button" className="btn" onClick={() => setReportTest(null)}>
                  Close
                </button>
                <button type="button" className="btn btn-primary" onClick={() => window.print()}>
                  Print report
                </button>
              </div>
            </div>
          );
        })() : null}
      </Modal>
    </div>
  );
}
