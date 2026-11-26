import { useState, type FormEvent } from 'react';
import { Banner, Card, Chip, Empty, Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst } from '../../../lib/format';
import { parseQuestionsJson, pickTwo, type ParsedLabQuestion } from '../../../lib/logic/flows';
import { fn, rpc } from '../../../lib/supabase';
import type {
  Course,
  CourseOutcome,
  QuestionDifficulty,
  QuestionRow,
  ReferenceSolutionRow,
  SessionQuestionRow,
  SessionRow,
  TestCaseRow,
} from '../../../lib/types';

function emptyQuestionDraft(course: Course, outcomes: readonly CourseOutcome[]) {
  const refs: Record<string, string> = {};
  for (const lang of course.allowed_langs) {
    refs[lang] = '';
  }
  return {
    title: '',
    co_code: outcomes[0]?.code ?? 'CO1',
    difficulty: 'medium' as QuestionDifficulty,
    statement: '',
    input_spec: '',
    output_spec: '',
    constraints: '',
    visible_tests: [
      { input: '', expected: '' },
      { input: '', expected: '' },
    ],
    hidden_tests: [
      { input: '', expected: '' },
      { input: '', expected: '' },
      { input: '', expected: '' },
    ],
    references: refs,
  };
}

export function LabQuestionsStep({
  course,
  outcomes,
  sessions,
  questions,
  testCases,
  references,
  sessionQuestions,
  onNotify,
  onRefresh,
}: {
  course: Course;
  outcomes: readonly CourseOutcome[];
  sessions: readonly SessionRow[];
  questions: readonly QuestionRow[];
  testCases: readonly TestCaseRow[];
  references: readonly ReferenceSolutionRow[];
  sessionQuestions: readonly SessionQuestionRow[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const [unitFilter, setUnitFilter] = useState<'all' | number>('all');
  const [draftSelection, setDraftSelection] = useState<Map<string, string[]>>(() => new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [validatingIds, setValidatingIds] = useState<Record<string, boolean>>({});

  // Write own question modal
  const [ownModalSession, setOwnModalSession] = useState<SessionRow | null>(null);
  const [ownForm, setOwnForm] = useState(() => emptyQuestionDraft(course, outcomes));
  const [ownErr, setOwnErr] = useState<string | null>(null);

  // Upload JSON confirmation modal
  const [uploadModalSession, setUploadModalSession] = useState<SessionRow | null>(null);
  const [uploadItems, setUploadItems] = useState<ParsedLabQuestion[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [previewItem, setPreviewItem] = useState<{ session: SessionRow; question: QuestionRow } | null>(null);

  if (course.plan_status !== 'approved' || sessions.length === 0) {
    return (
      <Empty
        title="Lab questions unlock after course plan approval and session planning"
        body="Approve your course plan with the HOD and save your session dates in Plan steps 1 and 3 first."
      />
    );
  }

  const getServerPicked = (sessionId: string): string[] =>
    sessionQuestions
      .filter((sq) => sq.session_id === sessionId)
      .sort((a, b) => a.slot - b.slot)
      .map((sq) => sq.question_id);

  const getSelectedIds = (sessionId: string): string[] =>
    draftSelection.get(sessionId) ?? getServerPicked(sessionId);

  const coById = new Map(outcomes.map((o) => [o.id, o]));
  const sessionUnit = (s: SessionRow): number => {
    const co = s.co_id ? coById.get(s.co_id) : undefined;
    return co?.unit ?? Math.min(5, Math.floor((s.n - 1) / 6) + 1);
  };

  const unitsPresent = Array.from(new Set(sessions.map(sessionUnit))).sort((a, b) => a - b);
  const visibleSessions =
    unitFilter === 'all' ? sessions : sessions.filter((s) => sessionUnit(s) === unitFilter);

  const tcByQuestion = new Map<string, TestCaseRow[]>();
  for (const tc of testCases) {
    const list = tcByQuestion.get(tc.question_id) ?? [];
    list.push(tc);
    tcByQuestion.set(tc.question_id, list);
  }

  const refCountByQuestion = new Map<string, number>();
  for (const r of references) {
    refCountByQuestion.set(r.question_id, (refCountByQuestion.get(r.question_id) ?? 0) + 1);
  }

  const questionsForSession = (sessionId: string) =>
    questions
      .filter((q) => q.session_id === sessionId && q.kind === 'lab')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const pickedSessionsCount = sessions.filter(
    (s) => sessionQuestions.filter((sq) => sq.session_id === s.id).length === 2,
  ).length;

  const sessionsMissingCandidates = sessions.filter(
    (s) => questionsForSession(s.id).length === 0,
  );

  const autoPickableSessions = sessions.filter((s) => {
    const existing = sessionQuestions.filter((sq) => sq.session_id === s.id);
    if (existing.length === 2) return false;
    return pickTwo(questionsForSession(s.id)).length === 2;
  });

  async function savePicked(session: SessionRow, ids: string[]) {
    if (ids.length !== 2) return;
    setBusyKey(`pick-${session.id}`);
    try {
      await rpc('pick_session_questions', {
        p_session_id: session.id,
        p_q1: ids[0],
        p_q2: ids[1],
      });
      setDraftSelection((prev) => {
        const next = new Map(prev);
        next.delete(session.id);
        return next;
      });
      onNotify(`Saved 2 questions for S${session.n}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  function handleToggle(session: SessionRow, q: QuestionRow) {
    if (q.valid !== true) return;
    const current = getSelectedIds(session.id);
    if (current.includes(q.id)) {
      const nextArr = current.filter((id) => id !== q.id);
      setDraftSelection((prev) => new Map(prev).set(session.id, nextArr));
      return;
    }
    if (current.length >= 2) {
      onNotify(`S${session.n} already has 2 questions selected. Uncheck one first.`, false);
      return;
    }
    const nextArr = [...current, q.id];
    setDraftSelection((prev) => new Map(prev).set(session.id, nextArr));
    if (nextArr.length === 2) {
      void savePicked(session, nextArr);
    }
  }

  async function assistPickOne(session: SessionRow) {
    const cands = questionsForSession(session.id);
    const best = pickTwo(cands);
    if (best.length !== 2) {
      onNotify(`S${session.n} needs at least 2 validated passing candidates before picking.`, false);
      return;
    }
    setDraftSelection((prev) => new Map(prev).set(session.id, best));
    await savePicked(session, best);
  }

  async function draftForSession(session: SessionRow) {
    setBusyKey(`gen-${session.id}`);
    try {
      await fn('ai-generate', {
        kind: 'lab_candidates',
        course_id: course.id,
        session_id: session.id,
      });
      onNotify(`Drafted and validated 4 candidates for S${session.n}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function validateOne(qId: string) {
    setValidatingIds((prev) => ({ ...prev, [qId]: true }));
    try {
      await fn('validate-question', { question_id: qId });
      onNotify('Question validated against all enabled languages.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setValidatingIds((prev) => ({ ...prev, [qId]: false }));
    }
  }

  async function rejectQuestion(session: SessionRow, q: QuestionRow) {
    setBusyKey(`reject-${q.id}`);
    try {
      await rpc('faculty_reject_question', { p_question_id: q.id });
      setDraftSelection((prev) => {
        const next = new Map(prev);
        const cur = next.get(session.id);
        if (cur) next.set(session.id, cur.filter((id) => id !== q.id));
        return next;
      });
      if (previewItem?.question.id === q.id) {
        setPreviewItem(null);
      }
      onNotify(`Rejected "${q.title}".`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function assistPickAll() {
    if (autoPickableSessions.length === 0) return;
    setBusyKey('bulk-pick');
    let count = 0;
    try {
      for (const s of autoPickableSessions) {
        const best = pickTwo(questionsForSession(s.id));
        if (best.length === 2) {
          await rpc('pick_session_questions', {
            p_session_id: s.id,
            p_q1: best[0],
            p_q2: best[1],
          });
          count++;
        }
      }
      onNotify(`Assist picked 2 validated questions for ${count} session(s).`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
      onRefresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function draftRemainingSequential() {
    if (sessionsMissingCandidates.length === 0) return;
    setBusyKey('bulk-gen');
    let generated = 0;
    try {
      for (const s of sessionsMissingCandidates) {
        await fn('ai-generate', {
          kind: 'lab_candidates',
          course_id: course.id,
          session_id: s.id,
        });
        generated++;
      }
      onNotify(`Drafted candidates for ${generated} session(s).`, true);
      onRefresh();
    } catch (err) {
      const msg = errorMessage(err);
      onNotify(
        generated > 0 ? `Stopped after ${generated} session(s): ${msg}` : msg,
        false,
      );
      onRefresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveOwn(e: FormEvent) {
    e.preventDefault();
    if (!ownModalSession) return;
    setOwnErr(null);
    setBusyKey('save-own');
    try {
      const qid = await rpc<string>('save_own_question', {
        p_session_id: ownModalSession.id,
        p_question: ownForm,
      });
      setOwnModalSession(null);
      setOwnForm(emptyQuestionDraft(course, outcomes));
      onRefresh();
      setValidatingIds((prev) => ({ ...prev, [qid]: true }));
      try {
        await fn('validate-question', { question_id: qid });
        onNotify('Own question saved and validated.', true);
      } catch (valErr) {
        onNotify(`Question saved; validation note: ${errorMessage(valErr)}`, false);
      } finally {
        setValidatingIds((prev) => ({ ...prev, [qid]: false }));
      }
      onRefresh();
    } catch (err) {
      setOwnErr(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleUploadFile(session: SessionRow, file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseQuestionsJson(text);
      setUploadItems(parsed.questions);
      setUploadErrors(parsed.errors);
      setUploadModalSession(session);
    } catch (err) {
      onNotify(errorMessage(err), false);
    }
  }

  async function confirmUpload() {
    if (!uploadModalSession || uploadItems.length === 0 || uploadErrors.length > 0) return;
    setBusyKey('upload-own');
    try {
      const ids = await rpc<string[]>('import_lab_questions', {
        p_session_id: uploadModalSession.id,
        p_items: uploadItems,
      });
      const targetSession = uploadModalSession.n;
      setUploadModalSession(null);
      setUploadItems([]);
      onRefresh();

      for (const qid of ids) {
        setValidatingIds((prev) => ({ ...prev, [qid]: true }));
        try {
          await fn('validate-question', { question_id: qid });
        } catch {
          // Validation status recorded on row / surfaced after refresh
        } finally {
          setValidatingIds((prev) => ({ ...prev, [qid]: false }));
        }
      }
      onNotify(`Uploaded and validated ${ids.length} question(s) for S${targetSession}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="seg" role="tablist" aria-label="Units">
          <button
            type="button"
            role="tab"
            className="seg-btn"
            aria-pressed={unitFilter === 'all'}
            onClick={() => setUnitFilter('all')}
          >
            All ({sessions.length})
          </button>
          {unitsPresent.map((u) => (
            <button
              key={u}
              type="button"
              role="tab"
              className="seg-btn"
              aria-pressed={unitFilter === u}
              onClick={() => setUnitFilter(u)}
            >
              U{u}
            </button>
          ))}
        </div>

        <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {pickedSessionsCount} / {sessions.length} sessions ready
        </div>
      </div>

      {visibleSessions.map((s) => {
        const cands = questionsForSession(s.id);
        const selIds = getSelectedIds(s.id);
        const co = s.co_id ? coById.get(s.co_id) : undefined;
        const pickedCount = sessionQuestions.filter((sq) => sq.session_id === s.id).length;

        return (
          <Card
            key={s.id}
            title={`S${s.n} · ${s.topic}`}
            actions={
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {s.scheduled_date ? formatDateIst(s.scheduled_date) : 'Unscheduled'} · {co?.code ?? 'CO1'} · L{s.btl}
                </span>
                <Chip tone={selIds.length === 2 && pickedCount === 2 ? 'good' : 'neutral'}>
                  {selIds.length} of 2 selected
                </Chip>
              </div>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {cands.length === 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 13, color: 'var(--muted)' }}>
                  <span>No candidates yet.</span>
                  <button
                    type="button"
                    className="btn btn-assist field-sm"
                    disabled={busyKey !== null}
                    onClick={() => void draftForSession(s)}
                  >
                    {busyKey === `gen-${s.id}` ? 'Drafting…' : 'Draft 4 candidates'}
                  </button>
                </div>
              ) : (
                <div className="grid-2">
                  {cands.map((q) => {
                    const checked = selIds.includes(q.id);
                    const isValid = q.valid === true;
                    const isValidating = validatingIds[q.id] === true;
                    const tcs = tcByQuestion.get(q.id) ?? [];
                    const visCount = tcs.filter((t) => !t.hidden).length;
                    const hidCount = tcs.filter((t) => t.hidden).length;
                    const refCount = refCountByQuestion.get(q.id) ?? 0;

                    return (
                      <div
                        key={q.id}
                        style={{
                          padding: 12,
                          borderRadius: 6,
                          border: `1px solid ${checked ? 'var(--ink)' : 'var(--border)'}`,
                          background: checked ? 'var(--surface-alt)' : 'var(--surface)',
                          opacity: isValid ? 1 : 0.6,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <label
                          style={{
                            display: 'flex',
                            gap: 10,
                            alignItems: 'flex-start',
                            cursor: isValid ? 'pointer' : 'not-allowed',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!isValid || busyKey !== null}
                            onChange={() => handleToggle(s, q)}
                            style={{ marginTop: 3, width: 16, height: 16 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{q.title}</div>
                            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                              {q.source === 'faculty' ? 'Yours' : q.difficulty} · {q.co_code} · {visCount} visible + {hidCount} hidden · {refCount} ref
                            </div>
                          </div>
                        </label>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          {isValidating ? (
                            <Chip tone="neutral">Validating…</Chip>
                          ) : q.valid === true ? (
                            <Chip tone="good">Checks passed</Chip>
                          ) : q.valid === false ? (
                            <Chip tone="bad">{q.validation_note || 'Validation failed · cannot select'}</Chip>
                          ) : (
                            <>
                              <Chip tone="warn">{q.validation_note || 'Needs validation'}</Chip>
                              <button
                                type="button"
                                className="btn field-sm"
                                disabled={busyKey !== null}
                                onClick={() => void validateOne(q.id)}
                              >
                                Validate
                              </button>
                            </>
                          )}
                        </div>

                        <details style={{ fontSize: 12, color: 'var(--muted)' }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--ink)' }}>Statement & test cases</summary>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <p style={{ color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{q.statement}</p>
                            {q.input_spec ? <div><strong>Input:</strong> {q.input_spec}</div> : null}
                            {q.output_spec ? <div><strong>Output:</strong> {q.output_spec}</div> : null}
                            {q.constraints ? <div><strong>Constraints:</strong> {q.constraints}</div> : null}
                          </div>
                        </details>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                          <button
                            type="button"
                            className="btn field-sm"
                            onClick={() => setPreviewItem({ session: s, question: q })}
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            className={checked ? 'btn btn-primary field-sm' : 'btn field-sm'}
                            disabled={!isValid || busyKey !== null}
                            onClick={() => handleToggle(s, q)}
                          >
                            {checked ? 'Selected' : 'Select'}
                          </button>
                          <button
                            type="button"
                            className="btn field-sm"
                            disabled={busyKey !== null}
                            onClick={() => void rejectQuestion(s, q)}
                          >
                            {busyKey === `reject-${q.id}` ? 'Rejecting…' : 'Reject'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busyKey !== null || cands.length === 0}
                  onClick={() => void assistPickOne(s)}
                >
                  Assist pick best 2
                </button>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busyKey !== null}
                  onClick={() => {
                    setOwnErr(null);
                    setOwnForm(emptyQuestionDraft(course, outcomes));
                    setOwnModalSession(s);
                  }}
                >
                  Write own question
                </button>
                <label className="btn field-sm" style={{ cursor: busyKey !== null ? 'not-allowed' : 'pointer' }}>
                  Upload own
                  <input
                    type="file"
                    accept=".json"
                    disabled={busyKey !== null}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      e.target.value = '';
                      void handleUploadFile(s, f);
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>
          </Card>
        );
      })}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busyKey !== null || autoPickableSessions.length === 0}
          onClick={() => void assistPickAll()}
        >
          {busyKey === 'bulk-pick'
            ? 'Picking…'
            : `Assist pick 2 for ${autoPickableSessions.length} sessions`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busyKey !== null || sessionsMissingCandidates.length === 0}
          onClick={() => void draftRemainingSequential()}
        >
          {busyKey === 'bulk-gen'
            ? 'Drafting…'
            : `Draft candidates for ${sessionsMissingCandidates.length} remaining sessions`}
        </button>
      </div>

      <Modal
        open={ownModalSession !== null}
        title={ownModalSession ? `Write own question · S${ownModalSession.n}` : 'Write own question'}
        onClose={() => setOwnModalSession(null)}
      >
        <form onSubmit={handleSaveOwn} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ownErr ? <Banner tone="err">{ownErr}</Banner> : null}
          <div className="grid-2">
            <label className="field-label">
              Title
              <input
                className="field"
                required
                value={ownForm.title}
                onChange={(e) => setOwnForm((p) => ({ ...p, title: e.target.value }))}
              />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label className="field-label">
                CO
                <select
                  className="field mono"
                  value={ownForm.co_code}
                  onChange={(e) => setOwnForm((p) => ({ ...p, co_code: e.target.value }))}
                >
                  {(outcomes.length > 0 ? outcomes.map((o) => o.code) : ['CO1']).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Difficulty
                <select
                  className="field"
                  value={ownForm.difficulty}
                  onChange={(e) =>
                    setOwnForm((p) => ({ ...p, difficulty: e.target.value as QuestionDifficulty }))
                  }
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
            </div>
          </div>

          <label className="field-label">
            Problem statement
            <textarea
              className="field"
              rows={3}
              required
              value={ownForm.statement}
              onChange={(e) => setOwnForm((p) => ({ ...p, statement: e.target.value }))}
              style={{ height: 'auto', padding: 8 }}
            />
          </label>

          <div className="grid-2">
            <label className="field-label">
              Input format
              <input
                className="field"
                value={ownForm.input_spec}
                onChange={(e) => setOwnForm((p) => ({ ...p, input_spec: e.target.value }))}
              />
            </label>
            <label className="field-label">
              Output format
              <input
                className="field"
                value={ownForm.output_spec}
                onChange={(e) => setOwnForm((p) => ({ ...p, output_spec: e.target.value }))}
              />
            </label>
          </div>

          <label className="field-label">
            Constraints
            <input
              className="field"
              value={ownForm.constraints}
              onChange={(e) => setOwnForm((p) => ({ ...p, constraints: e.target.value }))}
            />
          </label>

          <div style={{ fontSize: 12, fontWeight: 600 }}>2 visible tests</div>
          {ownForm.visible_tests.map((tc, idx) => (
            <div key={`vis-${idx}`} className="grid-2">
              <label className="field-label">
                Visible {idx + 1} input
                <input
                  className="field field-sm mono"
                  value={tc.input}
                  onChange={(e) =>
                    setOwnForm((p) => ({
                      ...p,
                      visible_tests: p.visible_tests.map((item, k) =>
                        k === idx ? { ...item, input: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
              <label className="field-label">
                Visible {idx + 1} expected
                <input
                  className="field field-sm mono"
                  required
                  value={tc.expected}
                  onChange={(e) =>
                    setOwnForm((p) => ({
                      ...p,
                      visible_tests: p.visible_tests.map((item, k) =>
                        k === idx ? { ...item, expected: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
            </div>
          ))}

          <div style={{ fontSize: 12, fontWeight: 600 }}>3 hidden tests</div>
          {ownForm.hidden_tests.map((tc, idx) => (
            <div key={`hid-${idx}`} className="grid-2">
              <label className="field-label">
                Hidden {idx + 1} input
                <input
                  className="field field-sm mono"
                  value={tc.input}
                  onChange={(e) =>
                    setOwnForm((p) => ({
                      ...p,
                      hidden_tests: p.hidden_tests.map((item, k) =>
                        k === idx ? { ...item, input: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
              <label className="field-label">
                Hidden {idx + 1} expected
                <input
                  className="field field-sm mono"
                  required
                  value={tc.expected}
                  onChange={(e) =>
                    setOwnForm((p) => ({
                      ...p,
                      hidden_tests: p.hidden_tests.map((item, k) =>
                        k === idx ? { ...item, expected: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
            </div>
          ))}

          <div style={{ fontSize: 12, fontWeight: 600 }}>Reference solutions (required per enabled language)</div>
          {course.allowed_langs.map((lang) => (
            <label key={lang} className="field-label">
              {lang.toUpperCase()} reference code
              <textarea
                className="field mono"
                rows={3}
                required
                value={ownForm.references[lang] ?? ''}
                onChange={(e) =>
                  setOwnForm((p) => ({
                    ...p,
                    references: { ...p.references, [lang]: e.target.value },
                  }))
                }
                style={{ height: 'auto', padding: 8 }}
              />
            </label>
          ))}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setOwnModalSession(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busyKey === 'save-own'}>
              {busyKey === 'save-own' ? 'Saving & validating…' : 'Save and validate'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={uploadModalSession !== null}
        title={uploadModalSession ? `Confirm uploaded questions · S${uploadModalSession.n}` : 'Upload questions'}
        onClose={() => setUploadModalSession(null)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {uploadErrors.length > 0 ? (
            <Banner tone="err">{uploadErrors.slice(0, 4).join(' ')}</Banner>
          ) : (
            <>
              <div style={{ fontSize: 13 }}>
                Ready to insert and validate <strong>{uploadItems.length}</strong> question(s):
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {uploadItems.map((q, idx) => (
                  <li key={`${q.title}-${idx}`}>
                    <strong>{q.title}</strong> ({q.difficulty} · {q.co_code} · 2 visible + 3 hidden tests)
                  </li>
                ))}
              </ul>
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setUploadModalSession(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyKey === 'upload-own' || uploadItems.length === 0 || uploadErrors.length > 0}
              onClick={() => void confirmUpload()}
            >
              {busyKey === 'upload-own' ? 'Uploading…' : 'Insert and validate'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={previewItem !== null}
        title={previewItem ? `Preview · S${previewItem.session.n} · ${previewItem.question.title}` : 'Question preview'}
        onClose={() => setPreviewItem(null)}
      >
        {previewItem ? (() => {
          const { session: ps, question: pq } = previewItem;
          const pTcs = tcByQuestion.get(pq.id) ?? [];
          const pVis = pTcs.filter((t) => !t.hidden);
          const pHid = pTcs.filter((t) => t.hidden);
          const pSelected = getSelectedIds(ps.id).includes(pq.id);
          const pValid = pq.valid === true;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Chip tone="neutral">{pq.difficulty}</Chip>
                <Chip tone="neutral">{pq.co_code}</Chip>
                <Chip tone={pValid ? 'good' : pq.valid === false ? 'bad' : 'warn'}>
                  {pValid ? 'Checks passed' : pq.valid === false ? 'Validation failed' : 'Needs validation'}
                </Chip>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Problem statement</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{pq.statement}</div>
              </div>
              {(pq.input_spec || pq.output_spec || pq.constraints) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, padding: 10, borderRadius: 6, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  {pq.input_spec ? <div><strong>Input:</strong> {pq.input_spec}</div> : null}
                  {pq.output_spec ? <div><strong>Output:</strong> {pq.output_spec}</div> : null}
                  {pq.constraints ? <div><strong>Constraints:</strong> {pq.constraints}</div> : null}
                </div>
              ) : null}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>
                    Visible test cases ({pVis.length})
                  </div>
                  {pVis.map((tc, i) => (
                    <div key={tc.id} className="mono" style={{ fontSize: 11.5, padding: 6, marginBottom: 4, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                      <div><strong>#{i + 1} In:</strong> {tc.input}</div>
                      <div><strong>Out:</strong> {tc.expected}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>
                    Hidden test cases ({pHid.length})
                  </div>
                  {pHid.map((tc, i) => (
                    <div key={tc.id} className="mono" style={{ fontSize: 11.5, padding: 6, marginBottom: 4, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                      <div><strong>#{i + 1} In:</strong> {tc.input}</div>
                      <div><strong>Out:</strong> {tc.expected}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                {!pValid ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={validatingIds[pq.id] === true}
                    onClick={() => void validateOne(pq.id)}
                  >
                    {validatingIds[pq.id] ? 'Validating…' : 'Validate'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  disabled={busyKey !== null}
                  onClick={() => void rejectQuestion(ps, pq)}
                >
                  {busyKey === `reject-${pq.id}` ? 'Rejecting…' : 'Reject'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!pValid || busyKey !== null}
                  onClick={() => {
                    handleToggle(ps, pq);
                    setPreviewItem(null);
                  }}
                >
                  {pSelected ? 'Unselect' : 'Select for session'}
                </button>
              </div>
            </div>
          );
        })() : null}
      </Modal>
    </div>
  );
}
