import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { formatTimeIst } from '../lib/format';
import { fileForLang, labelForLang, starterForLang, type SupportedLang } from '../lib/logic/starters';
import { fn } from '../lib/supabase';
import type {
  NotificationRow,
  QuestionRow,
  SubmissionRow,
  TestAttemptRow,
  TestCaseRow,
} from '../lib/types';

const LazyCodeEditor = lazy(() => import('./CodeEditor'));

export interface WorkbenchQuestion {
  question: QuestionRow;
  visibleTests: TestCaseRow[];
  hiddenCount: number;
}

interface VisibleVerdict {
  ord: number;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  status: string;
  time_ms: number;
}

interface RunResponse {
  mode: 'run' | 'submit';
  verdict: string;
  runtime_ms: number;
  memory_kb: number;
  compile_error: string | null;
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  visible_results: VisibleVerdict[];
  hidden_summary: { passed: number; total: number };
}

export function Workbench({
  mode,
  runContext = 'lab',
  paperId,
  title,
  allowedLangs,
  questions,
  initialDrafts,
  initialSubmissions,
  preAttempt,
  postAttempt,
  hints,
  sessionEndsLabel,
  onSaveDraft,
  onRunCompleted,
  onOpenPostTest,
  onExit,
}: {
  mode: 'lab' | 'preview';
  runContext?: 'lab' | 'exam' | 'instant';
  paperId?: string;
  title: string;
  allowedLangs: readonly string[];
  questions: readonly WorkbenchQuestion[];
  initialDrafts: ReadonlyMap<string, string>;
  initialSubmissions: readonly SubmissionRow[];
  preAttempt?: TestAttemptRow | null;
  postAttempt?: TestAttemptRow | null;
  hints?: readonly NotificationRow[];
  sessionEndsLabel?: string;
  onSaveDraft?: (questionId: string, lang: SupportedLang, code: string) => Promise<void>;
  onRunCompleted?: () => void;
  onOpenPostTest?: () => void;
  onExit: () => void;
}) {
  const isPreview = mode === 'preview';
  const langs = (allowedLangs.length > 0 ? allowedLangs : ['c']) as SupportedLang[];

  const [qi, setQi] = useState(0);
  const [langByQ, setLangByQ] = useState<Map<string, SupportedLang>>(() => new Map());
  const [codeMap, setCodeMap] = useState<Map<string, string>>(() => new Map(initialDrafts));
  const [runOutputs, setRunOutputs] = useState<Map<string, RunResponse>>(() => new Map());
  const [busyMode, setBusyMode] = useState<'run' | 'submit' | null>(null);
  const [saveLabel, setSaveLabel] = useState<string>(isPreview ? 'read-only preview' : 'saved');
  const [actionErr, setActionErr] = useState<string | null>(null);

  const dirtyRef = useRef<Set<string>>(new Set());

  const activeItem = questions[qi] ?? questions[0] ?? null;
  const activeQ = activeItem?.question ?? null;
  const activeLang: SupportedLang =
    (activeQ ? langByQ.get(activeQ.id) : undefined) ?? langs[0] ?? 'c';

  const getCode = (q: QuestionRow | null, lg: SupportedLang): string => {
    if (!q) return starterForLang(lg);
    const key = `${q.id}:${lg}`;
    if (codeMap.has(key)) return codeMap.get(key)!;
    if (initialDrafts.has(key)) return initialDrafts.get(key)!;
    const starterMap = new Map<string, string>(Object.entries(q.starter_code ?? {}));
    return starterMap.get(lg) || starterForLang(lg);
  };

  const currentCode = getCode(activeQ, activeLang);

  // 10s autosave timer in live lab mode
  useEffect(() => {
    if (isPreview || !onSaveDraft || !activeQ) return;
    const timer = window.setInterval(() => {
      const key = `${activeQ.id}:${activeLang}`;
      if (!dirtyRef.current.has(key)) return;
      const code = getCode(activeQ, activeLang);
      dirtyRef.current.delete(key);
      setSaveLabel('saving…');
      void onSaveDraft(activeQ.id, activeLang, code)
        .then(() => setSaveLabel('saved'))
        .catch(() => {
          dirtyRef.current.add(key);
          setSaveLabel('save failed');
        });
    }, 10_000);
    return () => window.clearInterval(timer);
    // Intentionally sync on question/lang switch cleanly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreview, onSaveDraft, activeQ?.id, activeLang, codeMap]);

  function handleCodeChange(nextCode: string) {
    if (!activeQ || isPreview) return;
    const key = `${activeQ.id}:${activeLang}`;
    dirtyRef.current.add(key);
    setSaveLabel('unsaved');
    setCodeMap((prev) => new Map(prev).set(key, nextCode));
  }

  async function execute(runMode: 'run' | 'submit') {
    if (!activeQ || isPreview) return;
    setActionErr(null);
    setBusyMode(runMode);
    const key = `${activeQ.id}:${activeLang}`;
    const code = getCode(activeQ, activeLang);

    try {
      if (onSaveDraft && dirtyRef.current.has(key)) {
        dirtyRef.current.delete(key);
        await onSaveDraft(activeQ.id, activeLang, code);
        setSaveLabel('saved');
      }

      const res = await fn<RunResponse>('run-code', {
        question_id: activeQ.id,
        lang: activeLang,
        code,
        mode: runMode,
        context: runContext,
        ...(paperId ? { paper_id: paperId } : {}),
      });
      setRunOutputs((prev) => new Map(prev).set(activeQ.id, res));
      onRunCompleted?.();
    } catch (err) {
      setActionErr(errorMessage(err));
    } finally {
      setBusyMode(null);
    }
  }

  const questionStatus = (qId: string, hidTotal: number) => {
    const liveOut = runOutputs.get(qId);
    const mySubs = initialSubmissions.filter((s) => s.question_id === qId);
    const maxHid = Math.max(
      liveOut?.hidden_passed ?? 0,
      ...mySubs.map((s) => s.hidden_passed),
    );
    const maxVis = Math.max(
      liveOut?.visible_passed ?? 0,
      ...mySubs.map((s) => s.visible_passed),
    );
    const reqHid = Math.max(hidTotal, 1);
    if (maxHid >= reqHid) return 'all';
    if (maxVis > 0) return 'visible';
    return 'none';
  };

  const allHiddenPassed =
    questions.length > 0 &&
    questions.every((item) => questionStatus(item.question.id, item.hiddenCount) === 'all');

  const activeRunOut = activeQ ? runOutputs.get(activeQ.id) : undefined;
  const activeLastSub = activeQ
    ? initialSubmissions.find((s) => s.question_id === activeQ.id)
    : undefined;
  const latestHiddenPassed = Math.max(
    activeRunOut?.hidden_passed ?? 0,
    activeLastSub?.hidden_passed ?? 0,
  );
  const activeHidTotal = activeItem?.hiddenCount ?? activeRunOut?.hidden_total ?? 3;

  const consoleText = (() => {
    if (actionErr) return `Error: ${actionErr}`;
    if (!activeRunOut) {
      if (activeLastSub) {
        return `$ last ${activeLastSub.mode} (${activeLastSub.lang}) · verdict ${activeLastSub.verdict}\nVisible ${activeLastSub.visible_passed}/${activeLastSub.visible_total}\nHidden  ${activeLastSub.hidden_passed}/${activeLastSub.hidden_total}  (inputs are not shown)\nRuntime ${activeLastSub.runtime_ms} ms`;
      }
      return `${labelForLang(activeLang)} · ${fileForLang(activeLang)}\nPress Run to execute the visible test cases, or Submit to evaluate all tests.`;
    }
    if (activeRunOut.compile_error) {
      return `Compile error:\n${activeRunOut.compile_error}`;
    }
    if (activeRunOut.mode === 'run') {
      const lines = activeRunOut.visible_results.map(
        (v) =>
          `Test ${v.ord}  ${v.passed ? 'PASSED' : `FAILED (${v.status})`}\n  input:    ${v.input}\n  expected: ${v.expected}\n  output:   ${v.actual}`,
      );
      lines.push(
        `\nVisible ${activeRunOut.visible_passed}/${activeRunOut.visible_total} passed (${activeRunOut.runtime_ms} ms). Submit to test hidden cases.`,
      );
      return lines.join('\n');
    }
    return `Submit result (${activeRunOut.verdict})\n\nVisible ${activeRunOut.visible_passed}/${activeRunOut.visible_total}\nHidden  ${activeRunOut.hidden_passed}/${activeRunOut.hidden_total}  (inputs stay hidden)\nRuntime ${activeRunOut.runtime_ms} ms · Memory ${activeRunOut.memory_kb} KB`;
  })();

  const latestHint = hints && hints.length > 0 ? hints[0]! : null;

  return (
    <section
      aria-label="Live lab workspace"
      className="dark-surface"
      style={{
        height: '100vh',
        minHeight: 620,
        display: 'flex',
        flexDirection: 'column',
        background: '#141413',
        color: '#E8E6DF',
      }}
    >
      <header
        style={{
          minHeight: 44,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '6px 14px',
          borderBottom: '1px solid #2C2B28',
        }}
      >
        <strong style={{ fontSize: 14, color: '#FFFFFF' }}>{title}</strong>

        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          {questions.map((item, idx) => {
            const st = questionStatus(item.question.id, item.hiddenCount);
            const dotColor =
              st === 'all' ? '#5FB3A1' : st === 'visible' ? '#E8A26B' : '#57554F';
            const selected = idx === qi;
            return (
              <button
                key={item.question.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setQi(idx)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 30,
                  padding: '0 10px',
                  border: 0,
                  borderRadius: 5,
                  cursor: 'pointer',
                  fontSize: 13,
                  background: selected ? '#2C2B28' : 'transparent',
                  color: selected ? '#FFFFFF' : '#A8A69E',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor }}
                />
                <span>Question {idx + 1}</span>
              </button>
            );
          })}
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: '#A8A69E',
          }}
        >
          <span>Language</span>
          <select
            aria-label="Language"
            value={activeLang}
            onChange={(e) => {
              if (!activeQ) return;
              const nextLang = e.target.value as SupportedLang;
              setLangByQ((prev) => new Map(prev).set(activeQ.id, nextLang));
            }}
            style={{
              height: 30,
              padding: '0 8px',
              border: '1px solid #3A3936',
              borderRadius: 5,
              background: '#1F1F1D',
              color: '#E8E6DF',
              fontSize: 13,
            }}
          >
            {langs.map((lg) => (
              <option key={lg} value={lg}>
                {labelForLang(lg)}
              </option>
            ))}
          </select>
        </label>

        <span style={{ flex: 1 }} />

        {!isPreview && preAttempt ? (
          <span
            className="mono"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#2C2B28',
              color: preAttempt.submitted_at ? '#9FE0BC' : '#CFCDC5',
            }}
          >
            {preAttempt.submitted_at
              ? `Pre-test ${preAttempt.score ?? 0}/5 · closed`
              : 'Pre-test in progress'}
          </span>
        ) : null}

        {!isPreview ? (
          <span
            className="mono"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#2C2B28',
              color: allHiddenPassed || postAttempt?.submitted_at ? '#9FE0BC' : '#A8A69E',
            }}
          >
            {postAttempt?.submitted_at
              ? `Post-test ${postAttempt.score ?? 0}/5`
              : allHiddenPassed
                ? 'Post-test open'
                : 'Post-test locked'}
          </span>
        ) : (
          <span
            className="mono"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#3A2618',
              color: '#FFB48A',
            }}
          >
            Preview mode
          </span>
        )}

        {sessionEndsLabel ? (
          <span
            className="mono"
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background: '#2C2B28',
              color: '#CFCDC5',
            }}
          >
            {sessionEndsLabel}
          </span>
        ) : null}

        <button
          type="button"
          disabled={isPreview || busyMode !== null || !activeQ}
          onClick={() => void execute('run')}
          style={{
            minHeight: 32,
            padding: '0 14px',
            border: '1px solid #3A3936',
            borderRadius: 5,
            background: '#1F1F1D',
            color: '#E8E6DF',
            fontSize: 13,
            cursor: isPreview ? 'not-allowed' : 'pointer',
            opacity: isPreview ? 0.55 : 1,
          }}
        >
          {busyMode === 'run' ? 'Running…' : 'Run'}
        </button>
        <button
          type="button"
          disabled={isPreview || busyMode !== null || !activeQ}
          onClick={() => void execute('submit')}
          style={{
            minHeight: 32,
            padding: '0 14px',
            border: 0,
            borderRadius: 5,
            background: '#0E5E52',
            color: '#FFFFFF',
            fontSize: 13,
            fontWeight: 600,
            cursor: isPreview ? 'not-allowed' : 'pointer',
            opacity: isPreview ? 0.55 : 1,
          }}
        >
          {busyMode === 'submit' ? 'Submitting…' : 'Submit'}
        </button>
        <button
          type="button"
          onClick={onExit}
          style={{
            minHeight: 32,
            padding: '0 10px',
            border: '1px solid #3A3936',
            borderRadius: 5,
            background: 'transparent',
            color: '#CFCDC5',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Exit
        </button>
      </header>

      {isPreview ? (
        <div
          role="status"
          style={{
            padding: '8px 14px',
            background: '#FFF1E8',
            color: '#7A3410',
            borderBottom: '1px solid #E2E0D8',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          Preview as student (read-only) — Run, Submit and Save are disabled.
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexWrap: 'nowrap' }}>
        <aside
          aria-label="Problem statement"
          style={{
            flex: '0 0 25%',
            minWidth: 260,
            overflowY: 'auto',
            background: '#FBFAF7',
            color: '#141413',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            borderRight: '1px solid #2C2B28',
          }}
        >
          {activeItem && activeQ ? (
            <>
              <div>
                <h1 style={{ fontSize: 17, fontWeight: 600 }}>
                  Q{qi + 1} · {activeQ.title}
                </h1>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  <span className="chip chip-neutral">{activeQ.co_code}</span>
                  <span className="chip chip-neutral">{activeQ.difficulty}</span>
                  <span className="chip chip-neutral">
                    {activeItem.visibleTests.length} visible · {activeItem.hiddenCount} hidden
                  </span>
                </div>
              </div>

              {latestHint ? (
                <div
                  role="status"
                  style={{
                    padding: 10,
                    borderRadius: 5,
                    border: '1px solid #C2410C',
                    background: '#FFF1E8',
                    color: '#7A3410',
                    fontSize: 12,
                  }}
                >
                  <strong>Hint from faculty · {formatTimeIst(latestHint.created_at)}</strong>
                  <div style={{ marginTop: 4 }}>{latestHint.body}</div>
                </div>
              ) : null}

              <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {activeQ.statement}
              </p>

              <div style={{ fontSize: 12, lineHeight: 1.6, color: '#3D3C38' }}>
                {activeQ.input_spec ? (
                  <div>
                    <strong>Input:</strong> {activeQ.input_spec}
                  </div>
                ) : null}
                {activeQ.output_spec ? (
                  <div>
                    <strong>Output:</strong> {activeQ.output_spec}
                  </div>
                ) : null}
                {activeQ.constraints ? (
                  <div>
                    <strong>Constraints:</strong> {activeQ.constraints}
                  </div>
                ) : null}
              </div>

              {activeItem.visibleTests.map((tc, idx) => {
                const verdict = activeRunOut?.visible_results.find((v) => v.ord === tc.ord);
                const stateLabel = verdict
                  ? verdict.passed
                    ? 'passed'
                    : 'failed'
                  : 'not run';
                const chipClass =
                  verdict && verdict.passed
                    ? 'chip chip-good'
                    : verdict
                      ? 'chip chip-bad'
                      : 'chip chip-neutral';

                return (
                  <div
                    key={tc.id}
                    style={{
                      flexShrink: 0,
                      border: '1px solid #E2E0D8',
                      borderRadius: 5,
                      overflow: 'hidden',
                      fontSize: 12,
                      background: '#FFFFFF',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 10px',
                        background: '#F1EFE9',
                      }}
                    >
                      <strong>Visible test {idx + 1}</strong>
                      <span className={chipClass}>{stateLabel}</span>
                    </div>
                    <pre className="mono" style={{ margin: 0, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
                      Input:    {tc.input || '(empty)'}
                      {'\n'}Expected: {tc.expected}
                    </pre>
                  </div>
                );
              })}

              <div
                style={{
                  flexShrink: 0,
                  padding: 10,
                  border: '1px dashed #D6D3C9',
                  borderRadius: 5,
                  fontSize: 12,
                  color: '#6B6A63',
                }}
              >
                Hidden test cases: {latestHiddenPassed}/{activeHidTotal} passed. Their inputs and
                outputs stay hidden; you only see passed or failed.
              </div>

              {!isPreview ? (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 5,
                    fontSize: 12,
                    border: `1px solid ${allHiddenPassed ? '#0E5E52' : '#D6D3C9'}`,
                    background: allHiddenPassed ? '#E6F0EC' : '#F1EFE9',
                    color: allHiddenPassed ? '#0E5E52' : '#3D3C38',
                  }}
                >
                  <strong>
                    {postAttempt?.submitted_at
                      ? `Post-test submitted · ${postAttempt.score ?? 0}/5`
                      : allHiddenPassed
                        ? 'Post-test open until 23:59'
                        : 'Post-test locked'}
                  </strong>
                  <div style={{ marginTop: 4 }}>
                    {postAttempt?.submitted_at
                      ? 'Completed for today.'
                      : allHiddenPassed
                        ? 'All hidden tests passed. Take 5 post-test MCQs now.'
                        : 'Opens when all hidden test cases of both questions pass.'}
                  </div>
                  {allHiddenPassed && !postAttempt?.submitted_at && onOpenPostTest ? (
                    <button
                      type="button"
                      className="btn btn-teal field-sm"
                      style={{ marginTop: 8 }}
                      onClick={onOpenPostTest}
                    >
                      Start post-test
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ fontSize: 13, color: '#6B6A63' }}>
              No active lab questions found for this session.
            </div>
          )}
        </aside>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              flex: '3 1 0',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: '#1B1B1A',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 12px',
                height: 32,
                borderBottom: '1px solid #2C2B28',
                fontSize: 12,
                color: '#A8A69E',
              }}
            >
              <span
                className="mono"
                style={{ color: '#E8E6DF', padding: '5px 0', borderBottom: '2px solid #3FA9F5' }}
              >
                {fileForLang(activeLang)}
              </span>
              <span className="mono">{saveLabel}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8F8D85' }}>
                Esc then Tab leaves editor
              </span>
            </div>

            <Suspense
              fallback={
                <div style={{ padding: 14, color: '#A8A69E', fontSize: 12 }}>Loading editor…</div>
              }
            >
              <LazyCodeEditor
                lang={activeLang}
                value={currentCode}
                readOnly={isPreview}
                onChange={handleCodeChange}
              />
            </Suspense>
          </div>

          <div
            aria-label="Execution console"
            style={{
              flex: '1 1 0',
              minHeight: 120,
              display: 'flex',
              flexDirection: 'column',
              background: '#11110F',
              borderTop: '1px solid #2C2B28',
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 14,
                padding: '0 12px',
                height: 30,
                alignItems: 'center',
                borderBottom: '1px solid #2C2B28',
                fontSize: 12,
              }}
            >
              <span style={{ color: '#E8E6DF', borderBottom: '2px solid #3FA9F5', padding: '4px 0' }}>
                Console
              </span>
              <span className="mono" style={{ color: '#8F8D85' }}>
                {activeRunOut
                  ? `${activeRunOut.mode} · ${activeRunOut.verdict}`
                  : activeLastSub
                    ? `last ${activeLastSub.mode}`
                    : 'idle'}
              </span>
            </div>
            <pre
              className="mono"
              style={{
                flex: 1,
                margin: 0,
                padding: '10px 14px',
                overflow: 'auto',
                fontSize: 12,
                lineHeight: 1.65,
                color: actionErr ? '#FFB4A9' : '#CFCDC5',
                whiteSpace: 'pre-wrap',
              }}
            >
              {consoleText}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
