import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../../lib/errors';
import { formatDateTimeIst } from '../../../lib/format';
import { fn, supabase } from '../../../lib/supabase';
import type { FeedbackQuestionItem } from '../../components/FeedbackGateModal';

interface CoProgressionRow {
  course_id: string;
  course_code: string;
  course_title: string;
  faculty_id: string | null;
  faculty_name: string;
  co_id: string;
  co_code: string;
  co_statement: string;
  total_sessions: number;
  conducted_sessions: number;
  co_completed: boolean;
  enrolled_students: number;
  existing_loop_id: string | null;
  loop_status: 'open' | 'closed' | null;
  loop_due_at: string | null;
  response_count: number;
}

interface FeedbackLoopRow {
  id: string;
  course_id: string;
  co_code: string;
  co_statement: string;
  title: string;
  status: 'open' | 'closed';
  due_at: string;
  questions: FeedbackQuestionItem[];
  hod_remarks: string;
  shared_at: string | null;
  created_at: string;
}

interface FeedbackResponseRow {
  id: string;
  loop_id: string;
  answers: Record<string, number>;
  comment: string;
  submitted_at: string;
}

function buildFallback15Questions(courseCode: string, coCode: string, coStatement: string): FeedbackQuestionItem[] {
  const coLabel = coStatement ? `${coCode} (${coStatement})` : coCode;
  return [
    // 5 Engagement
    { id: 'eng_1', category: 'engagement', prompt: `How engaging were the ${courseCode} lab sessions for ${coCode}?` },
    { id: 'eng_2', category: 'engagement', prompt: 'How actively were you able to participate in hands-on problem solving?' },
    { id: 'eng_3', category: 'engagement', prompt: 'Was the pacing of lab demonstrations and exercises comfortable?' },
    { id: 'eng_4', category: 'engagement', prompt: 'Did the pre-test and in-lab tasks keep you focused during the session?' },
    { id: 'eng_5', category: 'engagement', prompt: 'How effectively did the lab environment encourage peer/team learning?' },
    // 5 Support / Resource sharing / Doubt clarification
    { id: 'sup_1', category: 'support', prompt: 'How timely and helpful was faculty support when you faced code errors?' },
    { id: 'sup_2', category: 'support', prompt: 'Were reference notes, sample problems, and resources shared clearly?' },
    { id: 'sup_3', category: 'support', prompt: 'How effectively were your doubts clarified during and after the lab?' },
    { id: 'sup_4', category: 'support', prompt: 'Was viva / feedback from faculty constructive for improving your code?' },
    { id: 'sup_5', category: 'support', prompt: 'How satisfied are you with the overall guidance provided for this module?' },
    // 5 Context-specific for CO
    { id: 'co_1', category: 'co_specific', prompt: `How confident are you in applying ${coLabel} independently?` },
    { id: 'co_2', category: 'co_specific', prompt: `Did the lab exercises clearly reinforce the concepts of ${coCode}?` },
    { id: 'co_3', category: 'co_specific', prompt: `Were the visible and hidden test cases fair for assessing ${coCode}?` },
    { id: 'co_4', category: 'co_specific', prompt: `Can you solve new variations of ${coCode} problems without starter code?` },
    { id: 'co_5', category: 'co_specific', prompt: `How well did the post-test check your understanding of ${coCode}?` },
  ];
}

export function FeedbackLoopTab({ departmentId }: { departmentId: string | null }) {
  const [progression, setProgression] = useState<CoProgressionRow[]>([]);
  const [loops, setLoops] = useState<FeedbackLoopRow[]>([]);
  const [responsesByLoop, setResponsesByLoop] = useState<Record<string, FeedbackResponseRow[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  // Builder state
  const [selectedCo, setSelectedCo] = useState<CoProgressionRow | null>(null);
  const [loopTitle, setLoopTitle] = useState('');
  const [dueAt, setDueAt] = useState(() => {
    const d = new Date(Date.now() + 3 * 86_400_000);
    return d.toISOString().slice(0, 16);
  });
  const [questions, setQuestions] = useState<FeedbackQuestionItem[]>([]);
  const [newQCat, setNewQCat] = useState<FeedbackQuestionItem['category']>('custom');
  const [newQPrompt, setNewQPrompt] = useState('');

  // Extend & Close/Share state
  const [extendLoopId, setExtendLoopId] = useState<string | null>(null);
  const [extendDue, setExtendDue] = useState('');
  const [closeLoopId, setCloseLoopId] = useState<string | null>(null);
  const [hodRemarks, setHodRemarks] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchAll = useCallback(async () => {
    if (!departmentId) return null;
    const { data: progRows, error: pe } = await supabase.rpc('hod_co_progression', {
      p_department_id: departmentId,
    });
    const { data: loopRows } = await supabase
      .from('feedback_loops')
      .select('id, course_id, co_code, co_statement, title, status, due_at, questions, hod_remarks, shared_at, created_at')
      .eq('department_id', departmentId)
      .order('created_at', { ascending: false });
    const typedLoops = (loopRows ?? []) as FeedbackLoopRow[];
    let grouped: Record<string, FeedbackResponseRow[]> = {};
    if (typedLoops.length > 0) {
      const { data: respRows } = await supabase
        .from('feedback_responses')
        .select('id, loop_id, answers, comment, submitted_at')
        .in('loop_id', typedLoops.map((l) => l.id));
      grouped = {};
      for (const r of (respRows ?? []) as FeedbackResponseRow[]) {
        if (!grouped[r.loop_id]) grouped[r.loop_id] = [];
        grouped[r.loop_id]!.push(r);
      }
    }
    return {
      progRows: (progRows ?? []) as CoProgressionRow[],
      progErr: pe ? errorMessage(pe.message) : '',
      typedLoops,
      grouped,
    };
  }, [departmentId]);

  const loadData = useCallback(async () => {
    const res = await fetchAll();
    if (!res) return;
    setErr(res.progErr);
    setProgression(res.progRows);
    setLoops(res.typedLoops);
    setResponsesByLoop(res.grouped);
    setNowMs(Date.now());
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    void fetchAll().then((res) => {
      if (cancelled || !res) return;
      setErr(res.progErr);
      setProgression(res.progRows);
      setLoops(res.typedLoops);
      setResponsesByLoop(res.grouped);
      setNowMs(Date.now());
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  function openBuilderFor(row: CoProgressionRow) {
    setSelectedCo(row);
    setLoopTitle(`${row.course_code} · ${row.co_code} Completion Feedback`);
    setQuestions([]);
    setErr('');
    setNotice('');
  }

  async function draftWithAssist() {
    if (!selectedCo) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fn<{ questions: FeedbackQuestionItem[] }>('ai-generate', {
        kind: 'feedback_loop',
        course_id: selectedCo.course_id,
        co_code: selectedCo.co_code,
        co_statement: selectedCo.co_statement,
      });
      setQuestions(res.questions);
      setNotice('Assist drafted 15 rating questions (5 engagement, 5 support/doubt clarification, 5 CO-specific). Review or edit before launching.');
    } catch {
      // Fallback to structured 15-question template if AI endpoint or credits are unavailable
      setQuestions(buildFallback15Questions(selectedCo.course_code, selectedCo.co_code, selectedCo.co_statement));
      setNotice('Drafted 15 structured 5→1 rating questions (5 engagement, 5 support/doubt clarification, 5 CO-specific). You can edit or add more.');
    } finally {
      setBusy(false);
    }
  }

  function addCustomQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (!newQPrompt.trim()) return;
    setQuestions((prev) => [
      ...prev,
      {
        id: `q_${Date.now()}_${prev.length + 1}`,
        category: newQCat,
        prompt: newQPrompt.trim(),
      },
    ]);
    setNewQPrompt('');
  }

  async function launchLoop() {
    if (!selectedCo || questions.length === 0 || !loopTitle.trim()) {
      setErr('Add at least one 5→1 rating question and a title before launching.');
      return;
    }
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('hod_launch_feedback_loop', {
      p_course_id: selectedCo.course_id,
      p_co_id: selectedCo.co_id,
      p_co_code: selectedCo.co_code,
      p_co_statement: selectedCo.co_statement,
      p_title: loopTitle.trim(),
      p_due_at: dueAt ? new Date(dueAt).toISOString() : new Date(Date.now() + 3 * 86_400_000).toISOString(),
      p_questions: questions,
    });
    setBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    setSelectedCo(null);
    setQuestions([]);
    setNotice('Feedback loop launched. Enrolled students will be prompted to complete it upon opening the portal.');
    await loadData();
  }

  async function handleExtendDue(loopId: string) {
    if (!extendDue) return;
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('hod_update_feedback_due', {
      p_loop_id: loopId,
      p_due_at: new Date(extendDue).toISOString(),
    });
    setBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    setExtendLoopId(null);
    setExtendDue('');
    setNotice('Feedback due date extended.');
    await loadData();
  }

  async function handleCloseAndShare(loopId: string) {
    if (!hodRemarks.trim()) {
      setErr('Enter HoD Remarks before closing and sharing with Faculty & Dean.');
      return;
    }
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('hod_close_and_share_feedback', {
      p_loop_id: loopId,
      p_hod_remarks: hodRemarks.trim(),
    });
    setBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    setCloseLoopId(null);
    setHodRemarks('');
    setNotice('Feedback loop closed. Dashboard insights and HoD remarks shared with concerned Faculty and notified to Dean.');
    await loadData();
  }

  const eligibleCos = progression.filter((r) => r.co_completed && !r.existing_loop_id);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 700 }}>Feedback loop</h1>
        <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginTop: 4 }}>
          Track course progression across COs. When a CO completes, Assist flags eligibility to launch a mandatory 5→1 student feedback loop and share insights with Faculty and Dean.
        </p>
      </div>

      {err && <div style={{ padding: '10px 14px', borderRadius: 6, background: '#FDE8E8', color: 'var(--bad)', fontSize: '0.86rem' }}>{err}</div>}
      {notice && <div style={{ padding: '10px 14px', borderRadius: 6, background: '#DCEBE6', color: '#0E5E52', fontSize: '0.86rem' }}>{notice}</div>}

      {/* Assist popup for newly completed eligible COs */}
      {eligibleCos.length > 0 && (
        <div
          style={{
            padding: 14,
            borderRadius: 8,
            border: '1px solid #F2C9A0',
            background: '#FFF7ED',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#9A3412' }}>
            Assist: {eligibleCos.length} Course Outcome(s) completed and eligible for Feedback Loop
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {eligibleCos.map((c) => (
              <button
                key={`${c.course_id}-${c.co_id}`}
                type="button"
                className="btn field-sm"
                style={{ borderColor: '#EA580C', color: '#9A3412', background: '#FFFFFF' }}
                onClick={() => openBuilderFor(c)}
              >
                Run feedback for {c.course_code} {c.co_code}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Course & CO Progression Dashboard */}
      <section>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 10 }}>Course &amp; CO progression</h2>
        {progression.length === 0 ? (
          <div style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: '0.86rem' }}>
            No department courses with COs found yet.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Course', 'Faculty', 'CO', 'Sessions', 'Status', 'Feedback'].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 5 ? 'right' : 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {progression.map((row) => (
                <tr key={`${row.course_id}-${row.co_id}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 10px' }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{row.course_code}</span>{' '}
                    <span style={{ color: 'var(--muted)' }}>{row.course_title}</span>
                  </td>
                  <td style={{ padding: '9px 10px' }}>{row.faculty_name}</td>
                  <td style={{ padding: '9px 10px' }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{row.co_code}</span>
                  </td>
                  <td className="mono" style={{ padding: '9px 10px' }}>
                    {row.conducted_sessions}/{row.total_sessions}
                  </td>
                  <td style={{ padding: '9px 10px' }}>
                    {row.co_completed ? (
                      <span className="mono" style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: '#DCEBE6', color: '#0E5E52' }}>
                        Completed
                      </span>
                    ) : (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>In progress</span>
                    )}
                  </td>
                  <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                    {row.existing_loop_id ? (
                      <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {row.loop_status} ({row.response_count}/{row.enrolled_students})
                      </span>
                    ) : (
                      <button type="button" className="btn field-sm" onClick={() => openBuilderFor(row)}>
                        {row.co_completed ? 'Assist: Launch' : 'Draft loop'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Builder */}
      {selectedCo && (
        <section style={{ padding: 18, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                Draft feedback loop — {selectedCo.course_code} {selectedCo.co_code}
              </h2>
              <p style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{selectedCo.co_statement}</p>
            </div>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <button type="button" className="btn btn-primary field-sm" disabled={busy} onClick={() => void draftWithAssist()}>
                {busy ? 'Drafting…' : 'Assist: Draft 15 questions (5+5+5)'}
              </button>
              <button type="button" className="btn field-sm" onClick={() => setSelectedCo(null)}>
                Cancel
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <label className="field-label" style={{ flex: '1 1 260px' }}>
              Feedback title
              <input className="field" value={loopTitle} onChange={(e) => setLoopTitle(e.target.value)} />
            </label>
            <label className="field-label">
              Due date &amp; time
              <input className="field mono" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </label>
          </div>

          {questions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {questions.map((q, idx) => (
                <div key={q.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 11, minWidth: 92, color: 'var(--muted)' }}>
                    Q{idx + 1} · {q.category}
                  </span>
                  <input
                    className="field field-sm"
                    style={{ flex: 1 }}
                    value={q.prompt}
                    onChange={(e) =>
                      setQuestions((prev) => prev.map((item) => (item.id === q.id ? { ...item, prompt: e.target.value } : item)))
                    }
                  />
                  <button
                    type="button"
                    className="btn field-sm"
                    onClick={() => setQuestions((prev) => prev.filter((item) => item.id !== q.id))}
                  >
                    Del
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={addCustomQuestion} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field-label">
              Category
              <select className="field field-sm" value={newQCat} onChange={(e) => setNewQCat(e.target.value as FeedbackQuestionItem['category'])}>
                <option value="engagement">Engagement</option>
                <option value="support">Support / Resource / Doubts</option>
                <option value="co_specific">CO-specific</option>
                <option value="custom">Custom (5→1)</option>
              </select>
            </label>
            <label className="field-label" style={{ flex: '1 1 260px' }}>
              Add 5→1 rating question
              <input
                className="field field-sm"
                value={newQPrompt}
                onChange={(e) => setNewQPrompt(e.target.value)}
                placeholder="Type a custom rating question..."
              />
            </label>
            <button type="submit" className="btn field-sm">Add question</button>
          </form>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" disabled={busy || questions.length === 0} onClick={() => void launchLoop()}>
              {busy ? 'Launching…' : `Launch (${questions.length} questions) to students`}
            </button>
          </div>
        </section>
      )}

      {/* Active & Closed Feedback Loops + Insights */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Active &amp; completed feedback loops</h2>
        {loops.length === 0 ? (
          <div style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: '0.86rem' }}>
            No feedback loops launched yet.
          </div>
        ) : (
          loops.map((loop) => {
            const resps = responsesByLoop[loop.id] ?? [];
            const overallAvg =
              resps.length === 0 || loop.questions.length === 0
                ? null
                : (
                    resps.reduce((acc, r) => {
                      const vals = loop.questions.map((q) => Number(r.answers[q.id] ?? 0)).filter((v) => v > 0);
                      return acc + (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
                    }, 0) / resps.length
                  ).toFixed(2);
            const pastDue = loop.status === 'open' && new Date(loop.due_at).getTime() < nowMs;

            return (
              <div key={loop.id} style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.96rem' }}>
                      {loop.title} <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>({loop.co_code})</span>
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      Status: {loop.status} {pastDue ? '(past due)' : ''} · Due: {formatDateTimeIst(loop.due_at)} · Responses: {resps.length} · Avg rating: {overallAvg ?? '—'} / 5
                    </div>
                  </div>
                  {loop.status === 'open' && (
                    <div style={{ display: 'inline-flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() => {
                          setExtendLoopId(loop.id);
                          setExtendDue(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16));
                        }}
                      >
                        Extend due
                      </button>
                      <button type="button" className="btn btn-primary field-sm" onClick={() => setCloseLoopId(loop.id)}>
                        Close &amp; share
                      </button>
                    </div>
                  )}
                </div>

                {loop.questions.length > 0 && resps.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                    {(['engagement', 'support', 'co_specific'] as const).map((cat) => {
                      const qs = loop.questions.filter((q) => q.category === cat);
                      if (qs.length === 0) return null;
                      let sum = 0;
                      let cnt = 0;
                      for (const r of resps) {
                        for (const q of qs) {
                          const v = Number(r.answers[q.id] ?? 0);
                          if (v > 0) {
                            sum += v;
                            cnt++;
                          }
                        }
                      }
                      const avg = cnt > 0 ? (sum / cnt).toFixed(2) : '—';
                      return (
                        <div key={cat} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: '#FFFFFF' }}>
                          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{cat.replace('_', ' ')}</div>
                          <div className="mono" style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: 2 }}>{avg} / 5.00</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {loop.hod_remarks && (
                  <div style={{ padding: 10, borderRadius: 6, background: '#DCEBE6', color: '#0E5E52', fontSize: '0.84rem' }}>
                    <strong>HoD Remarks (shared with Faculty &amp; Dean):</strong> {loop.hod_remarks}
                  </div>
                )}

                {extendLoopId === loop.id && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="field field-sm mono" type="datetime-local" value={extendDue} onChange={(e) => setExtendDue(e.target.value)} />
                    <button type="button" className="btn btn-primary field-sm" disabled={busy} onClick={() => void handleExtendDue(loop.id)}>
                      Save new due
                    </button>
                    <button type="button" className="btn field-sm" onClick={() => setExtendLoopId(null)}>Cancel</button>
                  </div>
                )}

                {closeLoopId === loop.id && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                    <label className="field-label">
                      HoD Remarks (sent to concerned Faculty &amp; notified to Dean)
                      <textarea
                        className="field"
                        rows={2}
                        value={hodRemarks}
                        onChange={(e) => setHodRemarks(e.target.value)}
                        placeholder="Summarize strengths, action items, or doubt-clearing follow-ups..."
                      />
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-primary field-sm" disabled={busy} onClick={() => void handleCloseAndShare(loop.id)}>
                        Close &amp; notify Faculty + Dean
                      </button>
                      <button type="button" className="btn field-sm" onClick={() => setCloseLoopId(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
