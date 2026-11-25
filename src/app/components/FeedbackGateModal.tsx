import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { formatDateTimeIst } from '../../lib/format';
import { supabase } from '../../lib/supabase';

export interface FeedbackQuestionItem {
  id: string;
  category: 'engagement' | 'support' | 'co_specific' | 'custom';
  prompt: string;
}

interface PendingLoop {
  id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  co_code: string;
  co_statement: string;
  title: string;
  due_at: string;
  questions: FeedbackQuestionItem[];
}

const CATEGORY_LABELS: Record<FeedbackQuestionItem['category'], string> = {
  engagement: 'Engagement',
  support: 'Support / Resource sharing / Doubt clarification',
  co_specific: 'CO-specific learning',
  custom: 'Additional feedback',
};

const RATING_LABELS: Array<{ score: number; label: string }> = [
  { score: 5, label: '5 · Excellent' },
  { score: 4, label: '4 · Good' },
  { score: 3, label: '3 · Average' },
  { score: 2, label: '2 · Fair' },
  { score: 1, label: '1 · Needs work' },
];

export function FeedbackGateModal() {
  const [loops, setLoops] = useState<PendingLoop[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function refreshPending() {
    const { data, error } = await supabase.rpc('student_pending_feedback_loops');
    if (error || !Array.isArray(data)) return;
    setLoops(data as PendingLoop[]);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc('student_pending_feedback_loops');
      if (!cancelled && !error && Array.isArray(data)) {
        setLoops(data as PendingLoop[]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loops.length === 0) return null;

  const active = loops[0]!;
  const allAnswered = active.questions.every((q) => {
    const val = answers[q.id];
    return typeof val === 'number' && val >= 1 && val <= 5;
  });

  async function submitFeedback(e: React.FormEvent) {
    e.preventDefault();
    if (!allAnswered) {
      setErr('Please rate all questions from 5 to 1 before continuing.');
      return;
    }
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('student_submit_feedback', {
      p_loop_id: active.id,
      p_answers: answers,
      p_comment: comment,
    });
    setBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    setAnswers({});
    setComment('');
    await refreshPending();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-gate-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(17, 17, 16, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--paper)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div>
            <span
              className="mono"
              style={{
                display: 'inline-block',
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#FCE8D5',
                color: '#9A3412',
                marginBottom: 6,
              }}
            >
              Required CO Feedback · {loops.length} pending
            </span>
            <h2 id="feedback-gate-title" style={{ fontSize: '1.2rem', fontWeight: 700 }}>
              {active.course_code} — {active.co_code}: {active.title}
            </h2>
            {active.co_statement && (
              <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginTop: 4 }}>{active.co_statement}</p>
            )}
          </div>
          <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            Due {formatDateTimeIst(active.due_at)}
          </span>
        </div>

        <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginBottom: 16 }}>
          Rate each item from <strong>5</strong> (highest) to <strong>1</strong> (lowest). Portal access unlocks as soon as you submit.
        </p>

        {err && (
          <div style={{ marginBottom: 12, color: 'var(--bad)', fontSize: '0.85rem' }}>{err}</div>
        )}

        <form onSubmit={submitFeedback} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {active.questions.map((q, idx) => (
            <div
              key={q.id}
              style={{
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                Q{idx + 1} · {CATEGORY_LABELS[q.category] ?? 'Feedback'}
              </div>
              <div style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: 8 }}>{q.prompt}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {RATING_LABELS.map((r) => {
                  const selected = answers[q.id] === r.score;
                  return (
                    <button
                      key={r.score}
                      type="button"
                      className={selected ? 'btn btn-primary field-sm' : 'btn field-sm'}
                      onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: r.score }))}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <label className="field-label">
            Optional comment for faculty / HoD
            <textarea
              className="field"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Any additional suggestion or doubt..."
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !allAnswered}>
              {busy ? 'Submitting…' : 'Submit feedback & unlock portal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
