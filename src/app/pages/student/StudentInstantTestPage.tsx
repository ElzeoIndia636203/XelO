import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Banner, Card, Chip, ErrorNote, Loading } from '../../../components/ui';
import { Workbench, type WorkbenchQuestion } from '../../../components/Workbench';
import { errorMessage } from '../../../lib/errors';
import type { SupportedLang } from '../../../lib/logic/starters';
import { rpc, supabase } from '../../../lib/supabase';

interface InstantPretestQuestion {
  id: string;
  stem: string;
  options: string[];
}

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
  pretest_count?: number;
  pretest_marks?: number;
  pretest_score?: number;
  pretest_answers?: Record<string, number>;
  pretest_questions?: InstantPretestQuestion[];
  final_score?: number;
  answers: Record<string, { lang?: SupportedLang; code?: string }>;
  questions: Array<{
    id: string;
    title: string;
    statement: string;
    input_spec?: string;
    output_spec?: string;
    constraints?: string;
    sample_input?: string;
    sample_output?: string;
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
  const [preChoices, setPreChoices] = useState<Record<string, number>>({});
  const [busyPre, setBusyPre] = useState(false);
  const [preMsg, setPreMsg] = useState<string | null>(null);

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
      statement:
        q.sample_input || q.sample_output
          ? `${q.statement}\n\nSample Input:\n${q.sample_input ?? ''}\n\nSample Output:\n${q.sample_output ?? ''}`
          : q.statement,
      input_spec: q.input_spec ?? '',
      output_spec: q.output_spec ?? '',
      constraints: q.constraints ?? '',
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

  const preQs = payload.pretest_questions ?? [];
  const hasPretest = (payload.pretest_count ?? 0) > 0 && preQs.length > 0;
  const preSubmitted = Object.keys(payload.pretest_answers ?? {}).length > 0;

  async function submitPretest() {
    if (!payload) return;
    setBusyPre(true);
    setPreMsg(null);
    try {
      const score = await rpc<number>('student_submit_instant_pretest', {
        p_attempt_id: payload.attempt_id,
        p_answers: preChoices,
      });
      setPreMsg(`Pre-test submitted: ${score} / ${payload.pretest_marks ?? 0} marks.`);
      await loadAttempt();
    } catch (e) {
      setPreMsg(errorMessage(e));
    } finally {
      setBusyPre(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {hasPretest ? (
        <div style={{ padding: '12px 16px 0' }}>
          <Card
            title={`Pre-test MCQs (${payload.pretest_marks ?? 0} marks)`}
            actions={
              <Chip tone={preSubmitted ? 'good' : 'warn'}>
                {preSubmitted
                  ? `Score: ${payload.pretest_score ?? 0}/${payload.pretest_marks ?? 0}`
                  : `${preQs.length} questions`}
              </Chip>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {preMsg ? <Banner tone="ok">{preMsg}</Banner> : null}
              {preQs.map((pq, idx) => (
                <div key={pq.id} style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Q{idx + 1}. {pq.stem}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {pq.options.map((opt, oi) => {
                      const chosen = preSubmitted
                        ? Number((payload.pretest_answers ?? {})[pq.id]) === oi
                        : preChoices[pq.id] === oi;
                      return (
                        <label
                          key={oi}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: preSubmitted ? 'default' : 'pointer',
                          }}
                        >
                          <input
                            type="radio"
                            name={`pre-${pq.id}`}
                            disabled={preSubmitted || busyPre}
                            checked={chosen}
                            onChange={() => setPreChoices((prev) => ({ ...prev, [pq.id]: oi }))}
                          />
                          <span>{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!preSubmitted ? (
                <div>
                  <button
                    type="button"
                    className="btn btn-primary field-sm"
                    disabled={busyPre || Object.keys(preChoices).length < preQs.length}
                    onClick={() => void submitPretest()}
                  >
                    {busyPre ? 'Submitting…' : 'Submit pre-test'}
                  </button>
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}
      <Workbench
        mode="lab"
        runContext="instant"
        paperId={payload.attempt_id}
        title={`${payload.topic} (${payload.test_code}) · PRN ${payload.prn} · ${payload.student_name}`}
        allowedLangs={payload.allowed_langs}
        questions={workbenchQuestions}
        initialDrafts={initialDrafts}
        initialSubmissions={[]}
        sessionEndsLabel={`Score: ${payload.final_score ?? payload.total_score}/${payload.total_marks}`}
        onSaveDraft={async () => {}}
        onRunCompleted={loadAttempt}
        onExit={async () => {
          await supabase.rpc('student_submit_instant_test', { p_attempt_id: payload.attempt_id });
          navigate('/student');
        }}
      />
    </div>
  );
}
