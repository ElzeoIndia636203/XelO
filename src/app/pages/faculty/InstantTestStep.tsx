import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card, Chip, Empty } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateTimeIst } from '../../../lib/format';
import { fn, supabase } from '../../../lib/supabase';
import type { Course, CourseOutcome } from '../../../lib/types';

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
  allowed_langs: string[];
  active: boolean;
  created_at: string;
}

interface InstantAttemptRow {
  id: string;
  test_id: string;
  prn: string;
  student_name: string;
  total_score: number;
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
  onNotify,
}: {
  course: Course;
  outcomes: readonly CourseOutcome[];
  onNotify: (msg: string, ok: boolean) => void;
}) {
  const [topic, setTopic] = useState('');
  const [totalMarks, setTotalMarks] = useState(20);
  const [questionCount, setQuestionCount] = useState(2);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [coId, setCoId] = useState(outcomes[0]?.id ?? '');
  const [visibleCount, setVisibleCount] = useState(2);
  const [hiddenCount, setHiddenCount] = useState(3);
  const [visibleMarks, setVisibleMarks] = useState(4);
  const [hiddenMarks, setHiddenMarks] = useState(6);
  const [langs, setLangs] = useState<string[]>(() =>
    course.allowed_langs.length > 0 ? [...course.allowed_langs] : ['c', 'python'],
  );
  const [questions, setQuestions] = useState<InstantQuestionDraft[]>([]);
  const [activeSlot, setActiveSlot] = useState(1);
  const [activeVariant, setActiveVariant] = useState(1);
  const [genProgress, setGenProgress] = useState('');
  const [tests, setTests] = useState<InstantTestRow[]>([]);
  const [attemptsByTest, setAttemptsByTest] = useState<Record<string, InstantAttemptRow[]>>({});
  const [busy, setBusy] = useState(false);

  const selectedCo = outcomes.find((o) => o.id === coId) ?? outcomes[0] ?? null;

  const fetchTests = useCallback(async () => {
    const { data: tRows } = await supabase
      .from('instant_tests')
      .select('*')
      .eq('course_id', course.id)
      .order('created_at', { ascending: false });
    const typedTests = (tRows ?? []) as InstantTestRow[];
    let grouped: Record<string, InstantAttemptRow[]> = {};
    if (typedTests.length > 0) {
      const { data: aRows } = await supabase
        .from('instant_test_attempts')
        .select('id, test_id, prn, student_name, total_score, submitted_at, started_at')
        .in(
          'test_id',
          typedTests.map((t) => t.id),
        )
        .order('started_at', { ascending: false });
      grouped = {};
      for (const a of (aRows ?? []) as InstantAttemptRow[]) {
        if (!grouped[a.test_id]) grouped[a.test_id] = [];
        grouped[a.test_id]!.push(a);
      }
    }
    return { typedTests, grouped };
  }, [course.id]);

  useEffect(() => {
    let cancelled = false;
    void fetchTests().then((res) => {
      if (cancelled) return;
      setTests(res.typedTests);
      setAttemptsByTest(res.grouped);
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
    const perQMarks = Number((totalMarks / Math.max(1, questionCount)).toFixed(2));
    const allBuilt: InstantQuestionDraft[] = [];
    const avoidTitles: string[] = [];

    try {
      for (let slot = 1; slot <= questionCount; slot++) {
        setGenProgress(`Generating 15-question AI bucket for Question ${slot} of ${questionCount}…`);
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
          bucket_size: 15,
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
      onNotify(
        `Generated ${questionCount} × 15 (${allBuilt.length}) AI questions with problem definitions, sample cases, and visible/hidden tests. Each student gets 1 shuffled question per slot.`,
        true,
      );
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
      onNotify('Enter a topic and generate the 15-question AI buckets before publishing.', false);
      return;
    }
    if (visibleCount < 1 || hiddenCount < 1 || questions.some((q) => q.visible_tests.length < 1 || q.hidden_tests.length < 1)) {
      onNotify('Every question must have at least 1 visible and 1 hidden test case.', false);
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('faculty_create_instant_test', {
      p_course_id: course.id,
      p_topic: topic.trim(),
      p_total_marks: totalMarks,
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
    });
    setBusy(false);
    if (error) {
      onNotify(errorMessage(error.message), false);
      return;
    }
    const res = (data ?? {}) as { test_code?: string };
    onNotify(`Instant coding test published! Share code ${res.test_code ?? ''} with students.`, true);
    setTopic('');
    setQuestions([]);
    const refreshed = await fetchTests();
    setTests(refreshed.typedTests);
    setAttemptsByTest(refreshed.grouped);
  }

  async function toggleTestActive(test: InstantTestRow) {
    setBusy(true);
    const { error } = await supabase.rpc('faculty_toggle_instant_test', {
      p_test_id: test.id,
      p_active: !test.active,
    });
    setBusy(false);
    if (error) {
      onNotify(errorMessage(error.message), false);
      return;
    }
    const refreshed = await fetchTests();
    setTests(refreshed.typedTests);
    setAttemptsByTest(refreshed.grouped);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Create instant coding test">
        <form onSubmit={publishTest} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
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
              Total marks
              <input
                className="field mono"
                type="number"
                min={1}
                value={totalMarks}
                onChange={(e) => setTotalMarks(Number(e.target.value))}
              />
            </label>
            <label className="field-label">
              No. of questions
              <input
                className="field mono"
                type="number"
                min={1}
                max={20}
                value={questionCount}
                onChange={(e) => setQuestionCount(Number(e.target.value))}
              />
            </label>
            <label className="field-label">
              Difficulty
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
            <label className="field-label">
              Visible test cases (min 1)
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
                value={visibleMarks}
                onChange={(e) => setVisibleMarks(Number(e.target.value))}
              />
            </label>
            <label className="field-label">
              Hidden test cases (min 1)
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
                value={hiddenMarks}
                onChange={(e) => setHiddenMarks(Number(e.target.value))}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <span className="field-label" style={{ margin: 0 }}>Allowed languages:</span>
            {ALL_LANGS.map((l) => (
              <label key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={langs.includes(l.id)}
                  onChange={() => toggleLang(l.id)}
                />
                {l.label}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void generateAiBuckets()}>
              {genProgress || `Generate ${questionCount} × 15 AI question buckets (${questionCount * 15} questions)`}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || questions.length === 0}>
              {busy && !genProgress ? 'Publishing…' : 'Publish & generate test code'}
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
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Question slots:</span>
                  {Array.from({ length: questionCount }, (_, sIdx) => sIdx + 1).map((sNum) => (
                    <button
                      key={sNum}
                      type="button"
                      className={activeSlot === sNum ? 'btn btn-primary field-sm' : 'btn field-sm'}
                      onClick={() => {
                        setActiveSlot(sNum);
                        setActiveVariant(1);
                      }}
                    >
                      Slot {sNum} (15)
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>Bucket variant (1–15 shuffled per student):</span>
                  {slotQs.map((vq) => (
                    <button
                      key={vq.id}
                      type="button"
                      className={activeQ.id === vq.id ? 'btn btn-primary field-sm mono' : 'btn field-sm mono'}
                      onClick={() => setActiveVariant(vq.variant)}
                    >
                      #{vq.variant}
                    </button>
                  ))}
                </div>
                <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <input
                      className="field field-sm"
                      style={{ flex: '1 1 240px' }}
                      value={activeQ.title}
                      onChange={(e) => updateQ({ title: e.target.value })}
                      placeholder="Problem title"
                    />
                    <input
                      className="field field-sm mono"
                      type="number"
                      style={{ width: 90 }}
                      value={activeQ.marks}
                      onChange={(e) => updateQ({ marks: Number(e.target.value) })}
                      title="Marks for this question"
                    />
                  </div>
                  <label className="field-label">
                    Problem definition
                    <textarea
                      className="field"
                      rows={3}
                      value={activeQ.statement}
                      onChange={(e) => updateQ({ statement: e.target.value })}
                    />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                    <label className="field-label">
                      Input format
                      <input className="field field-sm" value={activeQ.input_spec} onChange={(e) => updateQ({ input_spec: e.target.value })} />
                    </label>
                    <label className="field-label">
                      Output format
                      <input className="field field-sm" value={activeQ.output_spec} onChange={(e) => updateQ({ output_spec: e.target.value })} />
                    </label>
                    <label className="field-label">
                      Constraints
                      <input className="field field-sm" value={activeQ.constraints} onChange={(e) => updateQ({ constraints: e.target.value })} />
                    </label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                    <label className="field-label">
                      Sample input
                      <textarea className="field field-sm mono" rows={2} value={activeQ.sample_input} onChange={(e) => updateQ({ sample_input: e.target.value })} />
                    </label>
                    <label className="field-label">
                      Sample output
                      <textarea className="field field-sm mono" rows={2} value={activeQ.sample_output} onChange={(e) => updateQ({ sample_output: e.target.value })} />
                    </label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>
                        Visible tests ({activeQ.visible_marks} marks · min 1)
                      </div>
                      {activeQ.visible_tests.map((tc, ti) => (
                        <div key={ti} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                          <input
                            className="field field-sm mono"
                            placeholder="Input"
                            value={tc.input}
                            onChange={(e) =>
                              updateQ({
                                visible_tests: activeQ.visible_tests.map((v, vi) =>
                                  vi === ti ? { ...v, input: e.target.value } : v,
                                ),
                              })
                            }
                          />
                          <input
                            className="field field-sm mono"
                            placeholder="Expected"
                            value={tc.expected}
                            onChange={(e) =>
                              updateQ({
                                visible_tests: activeQ.visible_tests.map((v, vi) =>
                                  vi === ti ? { ...v, expected: e.target.value } : v,
                                ),
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>
                        Hidden tests ({activeQ.hidden_marks} marks · min 1)
                      </div>
                      {activeQ.hidden_tests.map((tc, ti) => (
                        <div key={ti} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                          <input
                            className="field field-sm mono"
                            placeholder="Input"
                            value={tc.input}
                            onChange={(e) =>
                              updateQ({
                                hidden_tests: activeQ.hidden_tests.map((v, vi) =>
                                  vi === ti ? { ...v, input: e.target.value } : v,
                                ),
                              })
                            }
                          />
                          <input
                            className="field field-sm mono"
                            placeholder="Expected"
                            value={tc.expected}
                            onChange={(e) =>
                              updateQ({
                                hidden_tests: activeQ.hidden_tests.map((v, vi) =>
                                  vi === ti ? { ...v, expected: e.target.value } : v,
                                ),
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </form>
      </Card>

      <Card title="Published instant coding tests & student scores">
        {tests.length === 0 ? (
          <Empty title="No instant tests yet" body="Configure and publish an instant coding test above to generate a student join code." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {tests.map((t) => {
              const attempts = attemptsByTest[t.id] ?? [];
              return (
                <div key={t.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <span className="mono" style={{ fontSize: 15, fontWeight: 700, padding: '2px 8px', background: '#DCEBE6', color: '#0E5E52', borderRadius: 4, marginRight: 8 }}>
                        {t.test_code}
                      </span>
                      <strong>{t.topic}</strong> · {t.question_count} Qs · {t.total_marks} marks · {t.co_code || 'General'}
                    </div>
                    <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <Chip tone={t.active ? 'good' : 'neutral'}>{t.active ? 'Active' : 'Closed'}</Chip>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() => void navigator.clipboard?.writeText(t.test_code)}
                      >
                        Copy code
                      </button>
                      <button
                        type="button"
                        className="btn field-sm"
                        disabled={busy}
                        onClick={() => void toggleTestActive(t)}
                      >
                        {t.active ? 'Close' : 'Reopen'}
                      </button>
                    </div>
                  </div>
                  {attempts.length > 0 && (
                    <table style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th>PRN</th>
                          <th>Name</th>
                          <th>Score</th>
                          <th>Submitted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((a) => (
                          <tr key={a.id}>
                            <td className="mono">{a.prn}</td>
                            <td>{a.student_name}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>
                              {a.total_score} / {t.total_marks}
                            </td>
                            <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                              {a.submitted_at ? formatDateTimeIst(a.submitted_at) : 'In progress'}
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
    </div>
  );
}
