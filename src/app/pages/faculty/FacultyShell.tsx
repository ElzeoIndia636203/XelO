import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NotificationBell } from '../../../components/NotificationBell';
import { Banner, Elzeo, Wordmark } from '../../../components/ui';
import { todayIso } from '../../../lib/format';
import { parseAskCommand, type FacultyStepId } from '../../../lib/logic/ask';
import { computeNextBestActions } from '../../../lib/logic/nextBestActions';
import { usagePct } from '../../../lib/logic/credits';
import { useSession } from '../../../lib/session';
import { RolePortalToggle } from '../../components/RolePortalToggle';
import type { AiUsageSummary, Batch, Course, SessionRow } from '../../../lib/types';

interface StepDef {
  id: FacultyStepId;
  num: number;
  label: string;
  phase: 'Plan' | 'Prepare' | 'Run' | 'Complete';
  done: boolean;
  locked: boolean;
  meta: string;
}

const STEP_META: Record<FacultyStepId, { kicker: string; title: string; lead: string }> = {
  setup: {
    kicker: 'Step 1 · Plan',
    title: 'Course setup',
    lead: 'Course details, COs with Bloom levels, CO–PO map and the marking rubric, sent to the HOD as one course plan.',
  },
  batches: {
    kicker: 'Step 2 · Plan',
    title: 'Batch creation',
    lead: 'From the roster and lab seats: at most 65 per batch, split evenly.',
  },
  plan: {
    kicker: 'Step 3 · Plan',
    title: 'Session plan and calendar',
    lead: 'Lab dates come from the academic calendar. Each session carries its CO, BTL, pre-test and post-test windows.',
  },
  questions: {
    kicker: 'Step 4 · Prepare',
    title: 'Lab questions',
    lead: 'Assist drafts 4 candidates per session. Keep any 2, or add your own.',
  },
  banks: {
    kicker: 'Step 5 · Prepare',
    title: 'Pre-test and post-test banks',
    lead: 'Per session: 45 pre-test and 45 post-test questions, 15 per level. AI drafts, you approve.',
  },
  sessions: {
    kicker: 'Step 6 · Run',
    title: 'Sessions',
    lead: 'Open a session: attendance first, then pre-test performance and the live monitor.',
  },
  classroom: {
    kicker: 'Step 7 · Run',
    title: 'Classroom',
    lead: 'Timeline shared with onboarded students. Add tasks, resources and announcements in place.',
  },
  assessments: {
    kicker: 'Step 8 · Run',
    title: 'Assessments',
    lead: 'End-sem practical: rules, generate 40 approve 30, HOD approval, schedule, conduct, marks.',
  },
  reports: {
    kicker: 'Step 9 · Complete',
    title: 'Reports',
    lead: 'Course file, internal attainment report, and student lab files.',
  },
};

export function FacultyShell({
  course,
  activeStep,
  coCount,
  rubricTotal,
  batches,
  sessions,
  pickedSessionsCount = 0,
  banksReadySessionsCount = 0,
  aiUsage,
  facultyName,
  isHod,
  onSignOut,
  children,
}: {
  course: Course;
  activeStep: FacultyStepId;
  coCount: number;
  rubricTotal: number;
  batches: readonly Batch[];
  sessions: readonly SessionRow[];
  pickedSessionsCount?: number;
  banksReadySessionsCount?: number;
  aiUsage: AiUsageSummary | null;
  facultyName: string;
  isHod: boolean;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { profile } = useSession();
  const [cmd, setCmd] = useState('');
  const [askReply, setAskReply] = useState<string | null>(null);

  const planApproved = course.plan_status === 'approved';
  const activeCount = sessions.filter((s) => s.status === 'active' || s.status === 'conducted').length;
  const doneSteps = [
    planApproved,
    batches.length > 0,
    sessions.length > 0 && activeCount === sessions.length,
    sessions.length > 0 && pickedSessionsCount === sessions.length,
    sessions.length > 0 && banksReadySessionsCount === sessions.length,
  ].filter(Boolean).length;

  const steps: StepDef[] = [
    {
      id: 'setup',
      num: 1,
      label: 'Course setup',
      phase: 'Plan',
      done: planApproved,
      locked: false,
      meta: planApproved ? 'HOD ok' : course.plan_status,
    },
    {
      id: 'batches',
      num: 2,
      label: 'Batches',
      phase: 'Plan',
      done: batches.length > 0,
      locked: false,
      meta: String(batches.length),
    },
    {
      id: 'plan',
      num: 3,
      label: 'Session plan',
      phase: 'Plan',
      done: sessions.length > 0 && activeCount === sessions.length,
      locked: false,
      meta: `${activeCount}/${sessions.length || 30}`,
    },
    {
      id: 'questions',
      num: 4,
      label: 'Lab questions',
      phase: 'Prepare',
      done: sessions.length > 0 && pickedSessionsCount === sessions.length,
      locked: !planApproved || sessions.length === 0,
      meta: `${pickedSessionsCount}/${sessions.length || 30}`,
    },
    {
      id: 'banks',
      num: 5,
      label: 'Pre/post-test banks',
      phase: 'Prepare',
      done: sessions.length > 0 && banksReadySessionsCount === sessions.length,
      locked: !planApproved || sessions.length === 0,
      meta: `${banksReadySessionsCount}/${sessions.length || 30}`,
    },
    {
      id: 'sessions',
      num: 6,
      label: 'Sessions',
      phase: 'Run',
      done: false,
      locked: activeCount === 0,
      meta: activeCount > 0 ? 'ready' : 'locked',
    },
    {
      id: 'classroom',
      num: 7,
      label: 'Classroom',
      phase: 'Run',
      done: false,
      locked: !planApproved || batches.length === 0,
      meta: batches.length > 0 ? `${batches.length} batches` : 'locked',
    },
    {
      id: 'assessments',
      num: 8,
      label: 'Assessments',
      phase: 'Run',
      done: false,
      locked: !planApproved || batches.length === 0,
      meta: 'end-sem',
    },
    {
      id: 'reports',
      num: 9,
      label: 'Reports',
      phase: 'Complete',
      done: false,
      locked: !planApproved,
      meta: '—',
    },
  ];

  const phases: Array<'Plan' | 'Prepare' | 'Run' | 'Complete'> = ['Plan', 'Prepare', 'Run', 'Complete'];

  const aiTotal = aiUsage?.total_cap ?? 0;
  const aiLeft = Math.max(0, aiTotal - (aiUsage?.total_used ?? 0));
  const aiDaily = aiUsage?.daily_cap ?? 0;
  const aiToday = aiUsage?.today_used ?? 0;
  const aiPct = usagePct(aiLeft, aiTotal);

  const actions = computeNextBestActions({
    planStatus: course.plan_status,
    coCount,
    rubricTotal,
    batchesCount: batches.length,
    sessionsCount: sessions.length,
    pickedSessionsCount,
    banksReadySessionsCount,
    activeSessionsCount: activeCount,
  });

  const today = todayIso();
  const todaySessions = sessions.filter((s) => s.scheduled_date === today);

  function goStep(stepId: FacultyStepId, query = '') {
    navigate(`/faculty/c/${course.id}/${stepId}${query}`);
  }

  function handleAsk(e: FormEvent) {
    e.preventDefault();
    const res = parseAskCommand(cmd);
    setAskReply(res.reply);
    if (res.step) {
      const target = steps.find((s) => s.id === res.step);
      if (target && !target.locked) {
        const params = new URLSearchParams();
        if (res.sessionNumber) params.set('s', String(res.sessionNumber));
        if (res.inspectRoll) params.set('roll', res.inspectRoll);
        const qs = params.toString() ? `?${params.toString()}` : '';
        goStep(res.step, qs);
        setCmd('');
      }
    }
  }

  const meta = STEP_META[activeStep];

  return (
    <div className="console-wrap">
      <aside className="console-rail dark-surface no-print" aria-label="Lab lifecycle" style={{ maxWidth: 272 }}>
        <div style={{ padding: '0 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 20, lineHeight: 1.2 }}>
            <Wordmark dark sub="Assist" />
          </div>
          <div style={{ fontSize: 11, color: '#A8A69E' }}>Faculty workspace</div>
          <Link to="/faculty" style={{ fontSize: 12, color: '#CFCDC5', marginTop: 4 }}>
            ← All my courses
          </Link>
        </div>

        <div style={{ padding: 10, border: '1px solid #2C2B28', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: '#A8A69E' }}>Course</div>
          <div style={{ fontWeight: 600, color: '#FFFFFF' }}>
            {course.code} {course.title}
          </div>
          <div style={{ fontSize: 12, color: '#A8A69E' }}>
            {course.section} · Sem {course.semester} · {course.academic_year}
          </div>
          <div style={{ marginTop: 8, height: 4, background: '#2C2B28', borderRadius: 2 }}>
            <div
              style={{
                height: '100%',
                width: `${doneSteps * 20}%`,
                background: '#5FB3A1',
                borderRadius: 2,
              }}
            />
          </div>
          <div className="mono" style={{ marginTop: 6, fontSize: 11, color: '#A8A69E' }}>
            {doneSteps} of 5 setup steps done
          </div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {phases.map((phase) => (
            <div key={phase} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div
                style={{
                  padding: '0 8px 4px',
                  fontSize: 11,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  color: '#8F8D85',
                }}
              >
                {phase}
              </div>
              {steps
                .filter((s) => s.phase === phase)
                .map((s) => {
                  const isCurrent = s.id === activeStep;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={s.locked}
                      aria-current={isCurrent ? 'step' : undefined}
                      onClick={() => goStep(s.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        minHeight: 36,
                        padding: '0 8px',
                        border: 0,
                        borderRadius: 5,
                        cursor: s.locked ? 'not-allowed' : 'pointer',
                        fontSize: 13,
                        background: isCurrent ? '#2C2B28' : 'transparent',
                        color: s.locked ? '#6B6A63' : isCurrent ? '#FFFFFF' : '#CFCDC5',
                        fontWeight: isCurrent ? 600 : 400,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          width: 18,
                          height: 18,
                          flex: 'none',
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 600,
                          background: s.done ? 'var(--teal)' : 'transparent',
                          border: `1px solid ${s.done ? 'var(--teal)' : s.locked ? '#3E3D39' : '#57554F'}`,
                          color: s.locked ? '#6B6A63' : '#FFFFFF',
                        }}
                      >
                        {s.done ? '✓' : s.num}
                      </span>
                      <span style={{ flex: 1, textAlign: 'left' }}>{s.label}</span>
                      <span className="mono" style={{ fontSize: 11, color: s.locked ? '#6B6A63' : '#A8A69E' }}>
                        {s.meta}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>

        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 8px 0',
            fontSize: 12,
          }}
        >
          {isHod ? (
            <Link to="/hod" style={{ color: '#CFCDC5' }}>
              HOD console
            </Link>
          ) : null}
          <Link
            to={`/faculty/c/${course.id}/preview`}
            style={{ color: '#CFCDC5', textDecoration: 'underline', fontSize: 12 }}
          >
            Preview as student
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            style={{
              alignSelf: 'flex-start',
              padding: 0,
              border: 0,
              background: 'transparent',
              color: '#CFCDC5',
              cursor: 'pointer',
              fontSize: 12,
              textDecoration: 'underline',
            }}
          >
            Sign out
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8F8D85' }}>
            <span>by</span>
            <Elzeo dark />
          </div>
        </div>
      </aside>

      <div className="console-body">
        <header
          className="no-print"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            padding: '14px 24px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-alt)',
          }}
        >
          <form onSubmit={handleAsk} style={{ flex: '1 1 320px', display: 'flex', gap: 8 }}>
            <label htmlFor="ask-assist" style={{ position: 'absolute', left: -9999 }}>
              Ask Assist
            </label>
            <input
              id="ask-assist"
              className="field"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="Ask Assist: open S13, batches, session plan, course setup…"
              style={{ flex: 1, minWidth: 0, height: 38 }}
            />
            <button type="submit" className="btn btn-primary" style={{ height: 38 }}>
              Ask
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: todaySessions.length > 0 ? 'var(--assist)' : 'var(--faint)',
              }}
            />
            <span className="mono" style={{ color: 'var(--muted)' }}>
              {todaySessions.length > 0 ? `Today · S${todaySessions[0]!.n}` : 'No live lab'}
            </span>
          </div>

          <Link to={`/faculty/c/${course.id}/preview`} className="btn field-sm">
            Preview as student
          </Link>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 160 }}>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
              <span style={{ color: 'var(--muted)' }}>
                AI runs · {aiUsage?.tier ? (aiUsage.tier === 'elite' ? 'Elite' : 'Pro') : 'None'}
              </span>
              <span>
                {aiLeft} of {aiTotal} left
              </span>
            </div>
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 2 }}>
              <div
                style={{
                  height: '100%',
                  width: `${aiPct}%`,
                  background: aiDaily > 0 && aiToday >= aiDaily ? 'var(--assist)' : 'var(--teal)',
                  borderRadius: 2,
                }}
              />
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              today {aiToday}/{aiDaily} used
            </div>
          </div>

          {profile?.role === 'hod' ? <RolePortalToggle active="faculty" /> : null}
          <NotificationBell variant="light" />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{facultyName}</div>
        </header>

        {askReply ? (
          <div style={{ padding: '10px 24px 0' }}>
            <Banner tone="info">
              <strong>Assist:</strong> {askReply}
            </Banner>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: 24, alignItems: 'flex-start' }}>
          <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <div className="page-kicker">{meta.kicker}</div>
                <h1 className="page-title">{meta.title}</h1>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 480 }}>{meta.lead}</div>
            </div>
            {children}
          </main>

          <aside
            aria-label="Assist"
            className="no-print"
            style={{ flex: '1 1 280px', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <div className="card">
              <div className="card-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#C2410C"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
                  </svg>
                  <strong style={{ fontSize: 14 }}>Next best actions</strong>
                </div>
                <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {actions.length} suggested
                </span>
              </div>
              {actions.length === 0 ? (
                <div className="card-body" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  All setup steps are complete.
                </div>
              ) : (
                actions.map((ac) => (
                  <div
                    key={ac.id}
                    style={{
                      padding: '12px 16px',
                      borderTop: '1px solid var(--border-soft)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{ac.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{ac.why}</div>
                    <div>
                      <button type="button" className="btn btn-teal field-sm" onClick={() => goStep(ac.step)}>
                        {ac.cta}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div
              className="dark-surface"
              style={{
                background: 'var(--rail)',
                color: '#E8E6DF',
                borderRadius: 6,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#A8A69E' }}>
                Today · {today}
              </div>
              {todaySessions.length === 0 ? (
                <div style={{ fontSize: 13, color: '#CFCDC5' }}>No labs scheduled today.</div>
              ) : (
                todaySessions.map((s) => (
                  <div key={s.id} className="mono" style={{ fontSize: 13 }}>
                    S{s.n} · {s.topic}
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
