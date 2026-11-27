import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ProctorBar } from '../../../components/ProctorBar';
import { SecureCheckPanel } from '../../../components/SecureCheckPanel';
import { Banner, Card, Chip, ErrorNote, Loading } from '../../../components/ui';
import { Workbench, type WorkbenchQuestion } from '../../../components/Workbench';
import { errorMessage } from '../../../lib/errors';
import {
  defaultProctorConfig,
  resolveEffectiveRules,
  type ProctorConfig,
} from '../../../lib/logic/proctor';
import type { SupportedLang } from '../../../lib/logic/starters';
import { useProctorEngine } from '../../../lib/proctor-engine';
import { requestEntireScreenShare, requestExamFullscreen, stopProctorStreams } from '../../../lib/proctor-runtime';
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
  attendance_status?: string | null;
  same_duration_per_q?: boolean;
  total_duration_minutes?: number;
  question_durations?: number[];
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
  const [proctorConfig, setProctorConfig] = useState<ProctorConfig>(() => defaultProctorConfig(2));
  const [secureChecked, setSecureChecked] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [modalAlert, setModalAlert] = useState<{ ruleId: string; msg: string } | null>(null);
  const [holdRule, setHoldRule] = useState<{ ruleId: string; msg: string } | null>(null);
  const [secondTabBlocked, setSecondTabBlocked] = useState(false);
  const [autoSubmittedMsg, setAutoSubmittedMsg] = useState<string | null>(null);
  const [warningCount, setWarningCount] = useState(0);
  const [integrityScore, setIntegrityScore] = useState(100);
  const [faceCount, setFaceCount] = useState(1);
  const [pStatus, setPStatus] = useState({
    cameraOk: true,
    micOk: true,
    screenOk: true,
    fullscreenOk: true,
  });
  const [activeIdx, setActiveIdx] = useState(0);
  const [unlockedUpTo, setUnlockedUpTo] = useState(0);
  const [lockedIndices, setLockedIndices] = useState<Set<number>>(() => new Set());
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [autoSubmitTrigger, setAutoSubmitTrigger] = useState(0);
  const [disclaimerBreach, setDisclaimerBreach] = useState<{ ruleId: string; msg: string } | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);

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
    const p = data as InstantAttemptPayload;
    setPayload(p);
    const { data: tCfg } = await supabase
      .from('instant_tests')
      .select('proctor_config')
      .eq('id', p.test_id)
      .maybeSingle();
    if (tCfg && (tCfg as { proctor_config?: ProctorConfig }).proctor_config) {
      setProctorConfig((tCfg as { proctor_config: ProctorConfig }).proctor_config);
    }
    setLoading(false);
  }, [attemptId]);

  useProctorEngine({
    enabled: secureChecked && Boolean(payload?.attempt_id) && !secondTabBlocked,
    assessmentType: 'instant',
    attemptId: payload?.attempt_id ?? '',
    config: proctorConfig,
    callbacks: {
      onToast: (ruleId, msg) => {
        setToastMsg(`${ruleId}: ${msg}`);
        window.setTimeout(() => setToastMsg(null), 5000);
      },
      onModal: (ruleId, msg) => {
        setConsentChecked(false);
        setDisclaimerBreach({ ruleId, msg });
      },
      onHold: (ruleId, msg) => setHoldRule(ruleId ? { ruleId, msg } : null),
      onSecondTabBlocked: () => setSecondTabBlocked(true),
      onServerUpdate: (st) => {
        setWarningCount(st.warningCount);
        setIntegrityScore(st.integrityScore);
        if (!st.activeHoldRule) setHoldRule(null);
        if (st.warningCount === 1 && !disclaimerBreach && !st.autoSubmitted) {
          setConsentChecked(false);
          setDisclaimerBreach({
            ruleId: 'PROCTOR-WARN-1',
            msg: 'First malpractice warning detected.',
          });
        }
        if (st.autoSubmitted) {
          stopProctorStreams();
          void supabase.rpc('student_submit_instant_test', { p_attempt_id: payload?.attempt_id ?? '' });
          setAutoSubmittedMsg('Your instant coding test was automatically submitted after a 2nd consecutive malpractice breach. Only your faculty can reset it (up to 2 times).');
        }
      },
      onFaceCountChange: setFaceCount,
      onStatusChange: setPStatus,
    },
  });

  useEffect(() => {
    const t = setTimeout(() => {
      void loadAttempt();
    }, 0);
    return () => clearTimeout(t);
  }, [loadAttempt]);

  const activeQuestionObj = payload?.questions[activeIdx] ?? null;
  const qDurationSec = (() => {
    if (!payload || !activeQuestionObj) return 0;
    if (payload.same_duration_per_q === false && Array.isArray(payload.question_durations) && payload.question_durations[activeIdx]) {
      return Math.max(60, Number(payload.question_durations[activeIdx]) * 60);
    }
    const totalMin = Math.max(1, Number(payload.total_duration_minutes ?? 60));
    return Math.max(60, Math.round((totalMin * 60) / Math.max(1, payload.questions.length)));
  })();

  const lockAndAdvance = useCallback(
    async (idxToLock: number) => {
      if (!payload) return;
      setLockedIndices((prev) => new Set(prev).add(idxToLock));
      const nextIdx = idxToLock + 1;
      if (nextIdx < payload.questions.length) {
        setUnlockedUpTo((prev) => Math.max(prev, nextIdx));
        setActiveIdx(nextIdx);
      } else {
        await supabase.rpc('student_submit_instant_test', { p_attempt_id: payload.attempt_id });
        stopProctorStreams();
        setAutoSubmittedMsg('All questions completed and submitted.');
      }
    },
    [payload],
  );

  // Start per-question timer when the page loads the question for the first time
  useEffect(() => {
    if (!secureChecked || !payload || !activeQuestionObj || payload.submitted_at || autoSubmittedMsg) return;
    if (lockedIndices.has(activeIdx)) return;
    const storageKey = `xeio_q_timer_${payload.attempt_id}_${activeQuestionObj.id}`;
    let startMs = Number(window.localStorage.getItem(storageKey) || '0');
    if (!startMs) {
      startMs = Date.now();
      window.localStorage.setItem(storageKey, String(startMs));
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const left = Math.max(0, qDurationSec - elapsed);
      setRemainingSec(left);
      if (left <= 0) {
        setAutoSubmitTrigger((c) => c + 1);
        void lockAndAdvance(activeIdx);
      }
    };
    const initId = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(initId);
      window.clearInterval(id);
    };
  }, [secureChecked, payload, activeQuestionObj, activeIdx, qDurationSec, lockedIndices, autoSubmittedMsg, lockAndAdvance]);

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

  const effective = resolveEffectiveRules(proctorConfig);

  if (secondTabBlocked) {
    return (
      <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
        <ErrorNote message="BL-11: This assessment is already open in another tab." />
      </main>
    );
  }

  if (autoSubmittedMsg || payload.submitted_at) {
    return (
      <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card title={`${payload.topic} (${payload.test_code})`}>
          <Banner tone={autoSubmittedMsg ? 'err' : 'ok'}>
            {autoSubmittedMsg || 'This assessment has been submitted.'}
          </Banner>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/student')}>
              Back to student home
            </button>
          </div>
        </Card>
      </main>
    );
  }

  // Attendance gate — questions must NOT be shown unless attendance is confirmed
  if (payload.attendance_status !== 'present') {
    return (
      <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
        <Card title={`${payload.topic} (${payload.test_code})`}>
          <Banner tone="info">
            Your attendance has not been marked for this test. Contact your faculty to proceed.
          </Banner>
        </Card>
      </main>
    );
  }

  if (!secureChecked) {
    return (
      <main style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700 }}>{payload.topic} ({payload.test_code})</h1>
        <SecureCheckPanel
          config={proctorConfig}
          onReadyToStart={async (record) => {
            await rpc('student_save_proctor_start', {
              p_assessment_type: 'instant',
              p_attempt_id: payload.attempt_id,
              p_start_record: record,
            });
            setSecureChecked(true);
          }}
        />
      </main>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ProctorBar
        cameraRequired={effective.cameraRequired}
        micRequired={effective.micRequired}
        screenShareRequired={effective.screenShareRequired}
        cameraOk={pStatus.cameraOk}
        micOk={pStatus.micOk}
        screenOk={pStatus.screenOk}
        fullscreenOk={pStatus.fullscreenOk}
        faceCount={faceCount}
        warningCount={warningCount}
        integrityScore={integrityScore}
      />

      {toastMsg ? (
        <div role="status" style={{ position: 'fixed', top: 14, right: 14, zIndex: 1000, background: '#7A3410', color: '#FFF', padding: '10px 14px', borderRadius: 6, fontSize: 13 }}>
          {toastMsg}
        </div>
      ) : null}

      {disclaimerBreach ? (
        <div role="alertdialog" style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(11,17,32,0.88)', color: '#141413', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#FFF', padding: 22, borderRadius: 8, maxWidth: 500, width: '100%' }}>
            <h3 style={{ margin: '0 0 8px', color: '#991B1B' }}>
              Malpractice Warning ({disclaimerBreach.ruleId})
            </h3>
            <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>
              {disclaimerBreach.msg} Your current question will be auto-submitted and the next question will load.
            </p>
            <div style={{ padding: 10, borderRadius: 6, background: '#FEF2F2', border: '1px solid #FECACA', fontSize: 12.5, marginBottom: 12 }}>
              <strong>Disclaimer — Do NOT do any of the following:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                <li>Do not switch browser tabs, windows, or minimize fullscreen.</li>
                <li>Do not copy, paste, or open Developer Tools.</li>
                <li>Do not turn off your camera, microphone, or entire-screen share.</li>
                <li>Ensure no second person or face appears in the frame.</li>
              </ul>
              <div style={{ marginTop: 8, fontWeight: 600, color: '#991B1B' }}>
                A 2nd consecutive malpractice event will automatically submit your entire exam immediately (only faculty can reset up to 2 times).
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              <span>I have read the disclaimer and consent to continue without further violations.</span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!consentChecked}
              onClick={() => {
                setDisclaimerBreach(null);
                setModalAlert(null);
                setAutoSubmitTrigger((c) => c + 1);
                void lockAndAdvance(activeIdx);
              }}
            >
              Give consent & load next question
            </button>
          </div>
        </div>
      ) : null}

      {modalAlert ? (
        <div role="dialog" style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#FFF', padding: 20, borderRadius: 8, maxWidth: 420, width: '100%' }}>
            <h3 style={{ margin: '0 0 8px' }}>Proctor alert ({modalAlert.ruleId})</h3>
            <p style={{ fontSize: 13.5, margin: '0 0 14px' }}>{modalAlert.msg}</p>
            <button type="button" className="btn btn-primary" onClick={() => setModalAlert(null)}>
              Acknowledge & continue
            </button>
          </div>
        </div>
      ) : null}

      {holdRule ? (
        <div role="alertdialog" style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(11,17,32,0.92)', color: '#FFF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <h2 style={{ margin: '0 0 8px' }}>Assessment paused ({holdRule.ruleId})</h2>
            <p style={{ fontSize: 14, margin: '0 0 16px' }}>{holdRule.msg} Answers are locked until restored; timer keeps running.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  const ok = await requestExamFullscreen();
                  if (ok && holdRule.ruleId === 'BL-01') setHoldRule(null);
                }}
              >
                Return to fullscreen
              </button>
              {effective.screenShareRequired ? (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const res = await requestEntireScreenShare();
                    if (res.entireScreen && (holdRule.ruleId === 'BL-12' || holdRule.ruleId === 'SC-03')) {
                      setHoldRule(null);
                    }
                  }}
                >
                  Share entire screen
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
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
        sequentialLock
        activeIdx={activeIdx}
        onActiveIdxChange={setActiveIdx}
        unlockedUpTo={unlockedUpTo}
        lockedIndices={lockedIndices}
        autoSubmitTrigger={autoSubmitTrigger}
        timerLabel={
          lockedIndices.has(activeIdx)
            ? 'Submitted'
            : remainingSec !== null
              ? `Time left: ${String(Math.floor(remainingSec / 60)).padStart(2, '0')}:${String(remainingSec % 60).padStart(2, '0')}`
              : null
        }
        onQuestionSubmitted={(_qId, idx) => {
          void lockAndAdvance(idx);
        }}
        sessionEndsLabel={`Score: ${payload.final_score ?? payload.total_score}/${payload.total_marks}`}
        onSaveDraft={async (questionId, lang, code) => {
          await rpc('student_save_instant_draft', {
            p_attempt_id: payload.attempt_id,
            p_question_id: questionId,
            p_lang: lang,
            p_code: code,
          });
        }}
        onRunCompleted={loadAttempt}
        onExit={async () => {
          await supabase.rpc('student_submit_instant_test', { p_attempt_id: payload.attempt_id });
          stopProctorStreams();
          navigate('/student');
        }}
      />
    </div>
  );
}
