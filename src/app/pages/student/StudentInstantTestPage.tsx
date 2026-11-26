import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorNote, Loading } from '../../../components/ui';
import { Workbench, type WorkbenchQuestion } from '../../../components/Workbench';
import { errorMessage } from '../../../lib/errors';
import type { SupportedLang } from '../../../lib/logic/starters';
import { supabase } from '../../../lib/supabase';

interface InstantAttemptPayload {
  attempt_id: string;
  test_id: string;
  test_code: string;
  topic: string;
  total_marks: number;
  allowed_langs: SupportedLang[];
  prn: string;
  student_name: string;
  submitted_at: string | null;
  total_score: number;
  answers: Record<string, { lang?: SupportedLang; code?: string }>;
  questions: Array<{
    id: string;
    title: string;
    statement: string;
    difficulty: 'easy' | 'medium' | 'hard';
    marks: number;
    co_code: string;
    visible_tests: Array<{ input: string; expected: string }>;
    hidden_count: number;
  }>;
}

export function StudentInstantTestPage() {
  const { attemptId = '' } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<InstantAttemptPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const loadAttempt = useCallback(async () => {
    if (!attemptId) return;
    const { data, error } = await supabase.rpc('student_get_instant_attempt', {
      p_attempt_id: attemptId,
    });
    if (error || !data) {
      setErr(errorMessage(error?.message ?? 'not_found'));
      setLoading(false);
      return;
    }
    setPayload(data as InstantAttemptPayload);
    setLoading(false);
  }, [attemptId]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadAttempt();
    }, 0);
    return () => clearTimeout(t);
  }, [loadAttempt]);

  if (loading) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Loading instant coding assessment…" />
      </main>
    );
  }

  if (err || !payload) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <ErrorNote message={err || 'Assessment not found.'} />
      </main>
    );
  }

  const workbenchQuestions: WorkbenchQuestion[] = payload.questions.map((q) => ({
    question: {
      id: q.id,
      institution_id: '',
      course_id: '',
      kind: 'endsem',
      session_id: null,
      assessment_id: null,
      co_code: q.co_code || 'CO1',
      difficulty: q.difficulty,
      title: q.title,
      statement: q.statement,
      input_spec: '',
      output_spec: '',
      constraints: '',
      starter_code: {},
      status: 'approved',
      source: 'faculty',
      valid: true,
      validation_note: null,
      created_by: null,
      created_at: '',
    },
    visibleTests: q.visible_tests.map((tc, i) => ({
      id: `${q.id}-v-${i}`,
      institution_id: '',
      question_id: q.id,
      hidden: false,
      ord: i + 1,
      input: tc.input,
      expected: tc.expected,
      marks: 0,
    })),
    hiddenCount: q.hidden_count,
  }));

  const initialDrafts = new Map<string, string>();
  for (const [qid, ans] of Object.entries(payload.answers ?? {})) {
    if (ans.code && ans.lang) {
      initialDrafts.set(`${qid}:${ans.lang}`, ans.code);
    }
  }

  return (
    <Workbench
      mode="lab"
      runContext="instant"
      paperId={payload.attempt_id}
      title={`${payload.topic} (${payload.test_code}) · PRN ${payload.prn} · ${payload.student_name}`}
      allowedLangs={payload.allowed_langs}
      questions={workbenchQuestions}
      initialDrafts={initialDrafts}
      initialSubmissions={[]}
      sessionEndsLabel={`Score: ${payload.total_score}/${payload.total_marks}`}
      onSaveDraft={async () => {}}
      onRunCompleted={loadAttempt}
      onExit={async () => {
        await supabase.rpc('student_submit_instant_test', { p_attempt_id: payload.attempt_id });
        navigate('/student/endsem');
      }}
    />
  );
}
