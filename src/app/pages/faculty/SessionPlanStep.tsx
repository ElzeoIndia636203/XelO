import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarLinkCard } from '../../../components/CalendarLinkCard';
import { Banner, Card, Chip } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst } from '../../../lib/format';
import { applyMerge, planDates, suggestMerge } from '../../../lib/logic/flows';
import { rpc } from '../../../lib/supabase';
import type { Course, CourseOutcome, HolidayRow, SessionRow } from '../../../lib/types';

const WEEKDAYS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
] as const;

const DEFAULT_TOPICS = [
  'Input and output',
  'Operators and expressions',
  'Type conversion',
  'if-else branching',
  'switch-case statements',
  'Nested conditions',
  'for loops',
  'while and do-while loops',
  'Nested loops',
  'Pattern programs',
  'break and continue',
  'Series sums',
  '1-D arrays',
  'Linear and binary search',
  'Bubble and selection sort',
  '2-D arrays and matrices',
  'String functions',
  'String manipulation',
  'Functions',
  'Recursion',
  'Pointer basics',
  'Pointer arithmetic',
  'Pass by reference',
  'Dynamic memory allocation',
  'Structures',
  'Array of structures',
  'Unions and enums',
  'File write operations',
  'File read operations',
  'Mini project integration',
];

export function SessionPlanStep({
  course,
  outcomes,
  sessions,
  institutionHolidays,
  onNotify,
  onRefresh,
}: {
  course: Course;
  outcomes: readonly CourseOutcome[];
  sessions: readonly SessionRow[];
  institutionHolidays: readonly HolidayRow[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const locked = sessions.some((s) => s.status === 'active' || s.status === 'conducted');

  const [firstDay, setFirstDay] = useState('2027-01-06');
  const [lastDay, setLastDay] = useState('2027-04-28');
  const [weekdays, setWeekdays] = useState<number[]>([3]);
  const [reserveLast, setReserveLast] = useState(true);
  const [extraHolidays, setExtraHolidays] = useState<Array<{ day: string; label: string }>>([]);
  const [newHolDay, setNewHolDay] = useState('');
  const [newHolLabel, setNewHolLabel] = useState('');
  const [topics, setTopics] = useState<string[]>(() =>
    sessions.length > 0 ? sessions.map((s) => s.topic) : DEFAULT_TOPICS,
  );
  const [busy, setBusy] = useState(false);

  const allHolidays = [
    ...institutionHolidays.map((h) => ({ day: h.day, label: h.label })),
    ...extraHolidays,
  ];

  const plan = planDates({
    start: firstDay,
    end: lastDay,
    weekdays,
    holidays: allHolidays,
    sessions: topics.length,
    reserveLast,
  });

  const mergeSuggestion = plan.shortBy > 0 ? suggestMerge(topics) : null;
  const activeCount = sessions.filter((s) => s.status === 'active' || s.status === 'conducted').length;

  function toggleWeekday(d: number) {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  }

  function addExtraHoliday() {
    if (!newHolDay) return;
    if (extraHolidays.some((h) => h.day === newHolDay)) return;
    setExtraHolidays((prev) => [
      ...prev,
      { day: newHolDay, label: newHolLabel.trim() || 'Extra holiday' },
    ]);
    setNewHolDay('');
    setNewHolLabel('');
  }

  function acceptMerge() {
    if (!mergeSuggestion) return;
    setTopics((prev) => applyMerge(prev, mergeSuggestion.index));
  }

  async function savePlan() {
    if (plan.shortBy > 0 || plan.sessionDates.length < topics.length) {
      onNotify('Resolve the date shortfall before saving the session plan.', false);
      return;
    }
    setBusy(true);
    try {
      const cosIds = topics.map((_, i) => {
        if (outcomes.length === 0) return null;
        const coIdx = Math.min(outcomes.length - 1, Math.floor((i * outcomes.length) / topics.length));
        return outcomes[coIdx]?.id ?? null;
      });
      const btls = topics.map((_, i) => {
        if (outcomes.length === 0) return 3;
        const coIdx = Math.min(outcomes.length - 1, Math.floor((i * outcomes.length) / topics.length));
        return outcomes[coIdx]?.btl ?? 3;
      });

      await rpc('save_session_plan', {
        p_course_id: course.id,
        p_topics: topics,
        p_dates: plan.sessionDates.slice(0, topics.length),
        p_cos: cosIds,
        p_btls: btls,
      });
      onNotify(`Saved ${topics.length} sessions into the calendar.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Calendar configuration"
        actions={
          <Chip tone={plan.shortBy === 0 ? 'good' : 'warn'}>
            {plan.availablePeriods} dates available · {plan.neededPeriods} needed
          </Chip>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            <label className="field-label">
              First lab day
              <input
                className="field mono"
                type="date"
                disabled={locked}
                value={firstDay}
                onChange={(e) => setFirstDay(e.target.value)}
              />
            </label>
            <label className="field-label">
              Last teaching day
              <input
                className="field mono"
                type="date"
                disabled={locked}
                value={lastDay}
                onChange={(e) => setLastDay(e.target.value)}
              />
            </label>
            <label className="field-label">
              Sessions
              <input
                className="field mono"
                type="number"
                min={2}
                max={60}
                disabled={locked}
                value={topics.length}
                onChange={(e) => {
                  const n = Math.max(2, Math.min(60, Number(e.target.value) || 2));
                  setTopics((prev) => {
                    if (n <= prev.length) return prev.slice(0, n);
                    return [
                      ...prev,
                      ...Array.from({ length: n - prev.length }, (_, k) => `Lab topic ${prev.length + k + 1}`),
                    ];
                  });
                }}
                style={{ width: 84 }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 36, fontSize: 13 }}>
              <input
                type="checkbox"
                disabled={locked}
                checked={reserveLast}
                onChange={() => setReserveLast(!reserveLast)}
              />
              Reserve last day for makeup
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Lab weekdays:</span>
            {WEEKDAYS.map((w) => {
              const on = weekdays.includes(w.day);
              return (
                <button
                  key={w.day}
                  type="button"
                  disabled={locked}
                  className={`seg-btn ${on ? '' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleWeekday(w.day)}
                  style={{
                    border: `1px solid ${on ? 'var(--ink)' : 'var(--border)'}`,
                    background: on ? 'var(--ink)' : 'var(--surface)',
                    color: on ? '#FFFFFF' : 'var(--ink)',
                  }}
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field-label">
              Extra holiday
              <input
                className="field field-sm mono"
                type="date"
                disabled={locked}
                value={newHolDay}
                onChange={(e) => setNewHolDay(e.target.value)}
              />
            </label>
            <label className="field-label">
              Label
              <input
                className="field field-sm"
                disabled={locked}
                value={newHolLabel}
                onChange={(e) => setNewHolLabel(e.target.value)}
                placeholder="Sports day"
              />
            </label>
            <button type="button" className="btn field-sm" disabled={locked || !newHolDay} onClick={addExtraHoliday}>
              Add holiday
            </button>
            {allHolidays.map((h) => (
              <Chip key={h.day} tone="neutral">
                {h.day} · {h.label}
              </Chip>
            ))}
          </div>
        </div>
      </Card>

      {plan.shortBy > 0 && mergeSuggestion ? (
        <Banner
          tone="info"
          actions={
            <button
              type="button"
              className="btn btn-teal field-sm"
              disabled={locked}
              onClick={acceptMerge}
            >
              Accept suggestion
            </button>
          }
        >
          <strong>Short by {plan.shortBy} period(s).</strong> Assist suggests merging{' '}
          <em>{mergeSuggestion.a}</em> and <em>{mergeSuggestion.b}</em> into one session.
        </Banner>
      ) : null}

      <Card
        title="Schedule preview"
        actions={
          !locked ? (
            <button
              type="button"
              className="btn btn-primary field-sm"
              disabled={busy || plan.shortBy > 0}
              onClick={() => void savePlan()}
            >
              {busy ? 'Saving…' : 'Save session plan'}
            </button>
          ) : null
        }
        flush
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Lab date</th>
                <th>Sessions</th>
                <th>Pre-test window</th>
                <th>Post-test window</th>
                <th>Calendar</th>
              </tr>
            </thead>
            <tbody>
              {plan.periods.map((p) => (
                <tr
                  key={p.date}
                  style={
                    p.kind === 'blocked'
                      ? {
                          background:
                            'repeating-linear-gradient(135deg,#FFFFFF,#FFFFFF 6px,#F6F5F1 6px,#F6F5F1 12px)',
                        }
                      : undefined
                  }
                >
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {formatDateIst(p.date)}
                  </td>
                  <td>
                    {p.kind === 'lab' ? (
                      <div>
                        {p.sessionIndices.map((idx) => (
                          <div key={idx} style={{ fontSize: 13 }}>
                            <span className="mono" style={{ color: 'var(--muted)' }}>
                              S{idx + 1}
                            </span>{' '}
                            {topics[idx]}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>{p.label}</span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {p.kind === 'lab' ? `Prev day 18:00 → ${p.date} 09:59` : '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {p.kind === 'lab' ? `After hidden pass → ${p.date} 23:59` : '—'}
                  </td>
                  <td>
                    <Chip
                      tone={
                        p.kind === 'lab'
                          ? 'warn'
                          : p.kind === 'reserved'
                            ? 'good'
                            : 'neutral'
                      }
                    >
                      {p.kind === 'lab'
                        ? 'Draft'
                        : p.kind === 'reserved'
                          ? 'Reserved'
                          : p.kind === 'blocked'
                            ? 'Blocked'
                            : 'Spare'}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={`${activeCount}/${sessions.length} active in calendar`}
        actions={
          <Link className="btn field-sm" to={`/faculty/c/${course.id}/questions`}>
            Review questions to activate sessions
          </Link>
        }
        flush
      >
        {sessions.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>
            No sessions saved yet. Click "Save session plan" above to populate the course calendar.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Date</th>
                  <th>Topic</th>
                  <th>BTL</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">S{s.n}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {s.scheduled_date ? formatDateIst(s.scheduled_date) : '—'}
                    </td>
                    <td>{s.topic}</td>
                    <td className="mono">L{s.btl}</td>
                    <td>
                      <Chip tone={s.status === 'active' || s.status === 'conducted' ? 'good' : 'neutral'}>
                        {s.status}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CalendarLinkCard />
    </div>
  );
}
