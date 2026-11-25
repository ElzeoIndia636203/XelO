import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Banner, Card, Chip, ErrorNote, Loading } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { useLoad } from '../../../lib/hooks';
import { rpc } from '../../../lib/supabase';
import type { BankType } from '../../../lib/types';
import { StudentShell } from './StudentShell';

interface TestItemView {
  id: string;
  level: string;
  stem: string;
  options: string[];
}

interface StartTestResponse {
  attempt_id: string;
  bank: BankType;
  started_at: string;
  items: TestItemView[];
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function TestAttemptPage() {
  const { sessionId, bank } = useParams<{ sessionId: string; bank: string }>();
  const targetBank: BankType = bank === 'post' ? 'post' : 'pre';

  const [answers, setAnswers] = useState<Map<string, number>>(() => new Map());
  const [result, setResult] = useState<{ score: number; total: number } | null>(null);
  const [subErr, setSubErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    if (!sessionId) throw new Error('not_found');
    return rpc<StartTestResponse>('start_test', {
      p_session_id: sessionId,
      p_bank: targetBank,
    });
  }, [sessionId, targetBank]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setSubErr(null);
    setBusy(true);
    try {
      const payload = Object.fromEntries(answers.entries());
      const res = await rpc<{ score: number; total: number }>('submit_test', {
        p_attempt_id: data.attempt_id,
        p_answers: payload,
      });
      setResult(res);
    } catch (err) {
      setSubErr(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudentShell activeTab="home" todaySessionId={sessionId}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="page-kicker">{targetBank === 'pre' ? 'PRE-TEST · 2E 2M 1H' : 'POST-TEST · 1E 2M 2H'}</div>
            <h1 className="page-title">
              {targetBank === 'pre' ? 'Pre-test (single attempt)' : 'Post-test (single attempt)'}
            </h1>
          </div>
          <Link className="btn" to={sessionId ? `/student/lab/${sessionId}` : '/student'}>
            Back to lab
          </Link>
        </div>

        {loading && !data ? <Loading label="Preparing questions…" /> : null}
        {error ? <ErrorNote message={errorMessage(new Error(error))} /> : null}
        {subErr ? <Banner tone="err">{subErr}</Banner> : null}

        {result ? (
          <Card title="Test submitted">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
                Score: {result.score} / {result.total}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Recorded on your session rubric. Only one attempt is allowed per session.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {sessionId ? (
                  <Link className="btn btn-teal" to={`/student/lab/${sessionId}`}>
                    Return to lab IDE
                  </Link>
                ) : null}
                <Link className="btn" to="/student">
                  Home
                </Link>
              </div>
            </div>
          </Card>
        ) : data ? (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {data.items.map((item, idx) => (
              <Card
                key={item.id}
                title={`Question ${idx + 1} of ${data.items.length}`}
                actions={<Chip tone="neutral">{item.level}</Chip>}
              >
                <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{item.stem}</legend>
                  {item.options.map((opt, optIdx) => {
                    const checked = answers.get(item.id) === optIdx;
                    return (
                      <label
                        key={`${item.id}-${optIdx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: 10,
                          borderRadius: 5,
                          border: `1px solid ${checked ? 'var(--ink)' : 'var(--border-soft)'}`,
                          background: checked ? 'var(--surface-alt)' : 'var(--surface)',
                          cursor: 'pointer',
                          fontSize: 13,
                        }}
                      >
                        <input
                          type="radio"
                          name={`q-${item.id}`}
                          checked={checked}
                          onChange={() =>
                            setAnswers((prev) => new Map(prev).set(item.id, optIdx))
                          }
                        />
                        <span className="mono" style={{ color: 'var(--muted)' }}>
                          {LETTERS[optIdx]})
                        </span>
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                </fieldset>
              </Card>
            ))}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || answers.size < data.items.length}
              >
                {busy ? 'Submitting…' : 'Submit answers'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </StudentShell>
  );
}
