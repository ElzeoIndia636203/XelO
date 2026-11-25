import { useEffect, useRef, useState } from 'react';
import { Banner, Card, Chip, Empty, Kpis, Modal, Seg, statusTone } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, formatTimeIst, todayIso } from '../../../lib/format';
import { monitorAlerts, preTestAnalytics } from '../../../lib/logic/flows';
import { internalOutOf100, sessionMarks } from '../../../lib/logic/rubric';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  AttendanceRow,
  AttendanceState,
  BankItemRow,
  Batch,
  Course,
  DraftRow,
  Enrollment,
  Profile,
  SessionQuestionRow,
  SessionRow,
  SessionRunRow,
  SubmissionRow,
  TestAttemptRow,
  VivaRow,
} from '../../../lib/types';

interface SuggestedAttendanceItem {
  student_id: string;
  full_name: string;
  roll_no: string;
  email: string;
  suggested_state: AttendanceState;
}

const NEXT_STATE: Record<AttendanceState, AttendanceState> = {
  present: 'late',
  late: 'absent',
  absent: 'present',
};

function LiveSessionPanel({
  course,
  batch,
  session,
  allSessions,
  sessionQuestions,
  existingRun,
  batchStudents,
  initialInspectRoll,
  onNotify,
  onRunCreated,
  onRefreshWorkspace,
}: {
  course: Course;
  batch: Batch;
  session: SessionRow;
  allSessions: readonly SessionRow[];
  sessionQuestions: readonly SessionQuestionRow[];
  existingRun: SessionRunRow | undefined;
  batchStudents: readonly Profile[];
  initialInspectRoll?: string | null;
  onNotify: (msg: string, ok: boolean) => void;
  onRunCreated: () => void;
  onRefreshWorkspace: () => void;
}) {
  const startedCreateRef = useRef<string | null>(null);
  const [liveData, setLiveData] = useState<{
    run: SessionRunRow | null;
    attendance: AttendanceRow[];
    attempts: TestAttemptRow[];
    allAttempts: TestAttemptRow[];
    bankItems: BankItemRow[];
    submissions: SubmissionRow[];
    drafts: DraftRow[];
    vivas: VivaRow[];
    allVivas: VivaRow[];
    allAttendance: AttendanceRow[];
  } | null>(null);

  const [attModalOpen, setAttModalOpen] = useState(false);
  const [attEntries, setAttEntries] = useState<Array<SuggestedAttendanceItem & { state: AttendanceState }>>([]);
  const [remarkText, setRemarkText] = useState(existingRun?.remark ?? '');
  const [selectedAlertIds, setSelectedAlertIds] = useState<string[]>([]);
  const [hintText, setHintText] = useState('');
  const [taModalOpen, setTaModalOpen] = useState(false);
  const [vivaEdits, setVivaEdits] = useState<Map<string, string>>(() => new Map());
  const [inspectStudentId, setInspectStudentId] = useState<string | null>(() =>
    initialInspectRoll
      ? (batchStudents.find((s) => s.roll_no === initialInspectRoll)?.id ?? null)
      : null,
  );
  const [inspectSessionId, setInspectSessionId] = useState<string>(session.id);
  const [openCodeIds, setOpenCodeIds] = useState<Set<string>>(() => new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const autoOpenedForRunRef = useRef<string | null>(null);

  const loadNonceRef = useRef(0);
  const reloadLive = async () => {
    const seq = ++loadNonceRef.current;
    const stuIds = batchStudents.map((s) => s.id);
    const sessIds = allSessions.map((s) => s.id);

    const [
      runRes,
      attempts,
      bankItems,
      submissions,
      drafts,
      vivas,
      allVivas,
      allAttempts,
    ] = await Promise.all([
      supabase
        .from('session_runs')
        .select('*')
        .eq('session_id', session.id)
        .eq('batch_id', batch.id)
        .maybeSingle<SessionRunRow>(),
      fetchAll<TestAttemptRow>((from, to) =>
        supabase.from('test_attempts').select('*').eq('session_id', session.id).range(from, to),
      ),
      fetchAll<BankItemRow>((from, to) =>
        supabase.from('bank_items').select('*').eq('session_id', session.id).eq('bank', 'pre').range(from, to),
      ),
      fetchAll<SubmissionRow>((from, to) =>
        supabase.from('submissions').select('*').eq('course_id', course.id).order('created_at', { ascending: false }).range(from, to),
      ),
      stuIds.length > 0
        ? fetchAll<DraftRow>((from, to) =>
            supabase.from('drafts').select('*').in('student_id', stuIds).range(from, to),
          )
        : Promise.resolve<DraftRow[]>([]),
      fetchAll<VivaRow>((from, to) =>
        supabase.from('viva').select('*').eq('session_id', session.id).range(from, to),
      ),
      sessIds.length > 0
        ? fetchAll<VivaRow>((from, to) =>
            supabase.from('viva').select('*').in('session_id', sessIds).range(from, to),
          )
        : Promise.resolve<VivaRow[]>([]),
      sessIds.length > 0
        ? fetchAll<TestAttemptRow>((from, to) =>
            supabase.from('test_attempts').select('*').in('session_id', sessIds).range(from, to),
          )
        : Promise.resolve<TestAttemptRow[]>([]),
    ]);

    const run = runRes.data ?? existingRun ?? null;
    const attendance = run
      ? await fetchAll<AttendanceRow>((from, to) =>
          supabase.from('attendance').select('*').eq('session_run_id', run.id).range(from, to),
        )
      : [];

    const allAttendance =
      stuIds.length > 0
        ? await fetchAll<AttendanceRow>((from, to) =>
            supabase.from('attendance').select('*').in('student_id', stuIds).range(from, to),
          )
        : [];

    if (seq !== loadNonceRef.current) return;

    setLiveData({
      run,
      attendance,
      attempts,
      allAttempts,
      bankItems,
      submissions,
      drafts,
      vivas,
      allVivas,
      allAttendance,
    });
    setRemarkText(run?.remark ?? '');

    if (run && !run.attendance_done && autoOpenedForRunRef.current !== run.id) {
      autoOpenedForRunRef.current = run.id;
      void openAttendanceModal(run.id);
    }
  };

  async function openAttendanceModal(runId: string) {
    setAttModalOpen(true);
    try {
      const suggestions = await rpc<SuggestedAttendanceItem[]>('suggest_attendance', {
        p_run_id: runId,
      });
      setAttEntries(
        (suggestions ?? []).map((s) => ({
          ...s,
          state: s.suggested_state,
        })),
      );
    } catch (err) {
      onNotify(errorMessage(err), false);
    }
  }

  // Ensure idempotent run creation only if existingRun is absent after parent runs loaded
  useEffect(() => {
    const key = `${session.id}:${batch.id}`;
    if (!existingRun && startedCreateRef.current !== key) {
      startedCreateRef.current = key;
      void rpc<string>('start_session_run', {
        p_session_id: session.id,
        p_batch_id: batch.id,
      })
        .then(() => {
          onRunCreated();
          return reloadLive();
        })
        .catch((err) => onNotify(errorMessage(err), false));
      return;
    }
    void reloadLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, batch.id, existingRun?.id]);

  // Debounced Realtime on submissions (1.5s) + 60s poll for idle alerts
  useEffect(() => {
    let debounceTimer: number | undefined;
    const channel = supabase
      .channel(`live-subs-${course.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'submissions', filter: `course_id=eq.${course.id}` },
        () => {
          window.clearTimeout(debounceTimer);
          debounceTimer = window.setTimeout(() => {
            void reloadLive();
          }, 1500);
        },
      )
      .subscribe();

    const idleInterval = window.setInterval(() => {
      setNowTick(Date.now());
    }, 60_000);

    return () => {
      window.clearTimeout(debounceTimer);
      window.clearInterval(idleInterval);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.id, session.id, batch.id]);

  async function confirmAttendance() {
    if (!liveData?.run) return;
    setBusyKey('save-att');
    try {
      await rpc('save_attendance', {
        p_run_id: liveData.run.id,
        p_entries: attEntries.map((e) => ({ student_id: e.student_id, state: e.state })),
      });
      setAttModalOpen(false);
      onNotify('Attendance confirmed and live lab opened.', true);
      onRefreshWorkspace();
      await reloadLive();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function endSession() {
    if (!liveData?.run) return;
    setBusyKey('end-run');
    try {
      await rpc('end_session_run', { p_run_id: liveData.run.id, p_remark: remarkText });
      onNotify(`Ended S${session.n} for ${batch.name}.`, true);
      onRefreshWorkspace();
      await reloadLive();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function saveViva(studentId: string, rawVal: string) {
    const val = Number(rawVal);
    if (Number.isNaN(val)) return;
    setBusyKey(`viva-${studentId}`);
    try {
      await rpc('set_viva', {
        p_student_id: studentId,
        p_session_id: session.id,
        p_assessment_id: null,
        p_marks: val,
      });
      onNotify('Viva marks saved.', true);
      await reloadLive();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSendHint() {
    if (!liveData?.run || selectedAlertIds.length === 0 || !hintText.trim()) return;
    setBusyKey('send-hint');
    try {
      const cnt = await rpc<number>('send_hint', {
        p_run_id: liveData.run.id,
        p_student_ids: selectedAlertIds,
        p_text: hintText.trim(),
      });
      setHintText('');
      onNotify(`Hint delivered live to ${cnt} student(s).`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleFlagSlow() {
    if (selectedAlertIds.length === 0) return;
    setBusyKey('flag-slow');
    try {
      for (const sid of selectedAlertIds) {
        await rpc('flag_student', {
          p_course_id: course.id,
          p_student_id: sid,
          p_kind: 'slow',
          p_note: `Flagged from S${session.n} live alerts`,
        });
      }
      onNotify(`Added ${selectedAlertIds.length} student(s) to slow-learner list.`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  const run = liveData?.run ?? existingRun ?? null;
  const attMap = new Map((liveData?.attendance ?? []).map((a) => [a.student_id, a.state]));
  const sessionPicked = sessionQuestions
    .filter((sq) => sq.session_id === session.id)
    .sort((a, b) => a.slot - b.slot);
  const q1Id = sessionPicked[0]?.question_id;
  const q2Id = sessionPicked[1]?.question_id;

  const sessionSubs = (liveData?.submissions ?? []).filter((s) => s.session_id === session.id);
  const preAttempts = (liveData?.attempts ?? []).filter((a) => a.bank === 'pre');
  const postAttempts = (liveData?.attempts ?? []).filter((a) => a.bank === 'post');
  const preMap = new Map(preAttempts.map((a) => [a.student_id, a]));
  const postMap = new Map(postAttempts.map((a) => [a.student_id, a]));
  const vivaMap = new Map((liveData?.vivas ?? []).map((v) => [v.student_id, v.marks]));

  const qStatusLabel = (stuId: string, qId?: string): string => {
    if (!qId) return 'Not started';
    const qSubs = sessionSubs.filter((s) => s.student_id === stuId && s.question_id === qId);
    if (qSubs.some((s) => s.hidden_total > 0 && s.hidden_passed >= s.hidden_total)) {
      return 'All passed';
    }
    if (qSubs.some((s) => s.visible_passed > 0)) return 'Visible passed';
    if (qSubs.length > 0) return 'In progress';
    return 'Not started';
  };

  const batchIds = new Set(batchStudents.map((s) => s.id));
  const presentCount = batchStudents.filter((s) => attMap.get(s.id) === 'present').length;
  const lateCount = batchStudents.filter((s) => attMap.get(s.id) === 'late').length;
  const absentSet = new Set(
    batchStudents.filter((s) => attMap.get(s.id) === 'absent').map((s) => s.id),
  );
  const preDoneCount = batchStudents.filter((s) => preMap.get(s.id)?.submitted_at).length;
  const allHiddenCount = batchStudents.filter(
    (s) => qStatusLabel(s.id, q1Id) === 'All passed' && qStatusLabel(s.id, q2Id) === 'All passed',
  ).length;

  const analytics = preTestAnalytics(
    preAttempts.filter((a) => batchIds.has(a.student_id)),
    liveData?.bankItems ?? [],
  );
  const histMax = Math.max(1, ...analytics.histogram);
  const skippedPre = batchStudents.filter((s) => !absentSet.has(s.id) && !preMap.get(s.id)?.submitted_at);

  const lastDraftMap = new Map<string, number>();
  for (const d of liveData?.drafts ?? []) {
    const t = Date.parse(d.updated_at);
    if (!Number.isNaN(t)) {
      lastDraftMap.set(d.student_id, Math.max(lastDraftMap.get(d.student_id) ?? 0, t));
    }
  }

  const alerts = monitorAlerts(
    batchStudents.map((s) => ({ id: s.id, fullName: s.full_name, rollNo: s.roll_no ?? '' })),
    sessionSubs,
    lastDraftMap,
    absentSet,
    nowTick,
    run?.started_at ? Date.parse(run.started_at) : null,
  );

  const attCountsInModal = {
    p: attEntries.filter((e) => e.state === 'present').length,
    l: attEntries.filter((e) => e.state === 'late').length,
    a: attEntries.filter((e) => e.state === 'absent').length,
  };

  const runStateLabel = !run
    ? 'Ready'
    : run.ended_at
      ? 'Ended'
      : run.attendance_done
        ? 'Live'
        : 'Attendance pending';

  const inspectedStudent = batchStudents.find((s) => s.id === inspectStudentId) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={`S${session.n} · ${session.topic} (${batch.name})`}
        actions={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Chip tone={statusTone(run?.ended_at ? 'completed' : run?.attendance_done ? 'active' : 'draft')}>
              {runStateLabel}
            </Chip>
            <button
              type="button"
              className="btn field-sm"
              onClick={() => {
                if (run) void openAttendanceModal(run.id);
              }}
            >
              Attendance · {presentCount + lateCount}/{batchStudents.length}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {batch.slot} · {batch.room} · {batch.staff}
          </div>
          {!run?.ended_at && run?.attendance_done ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input
                className="field field-sm"
                aria-label="Session remark"
                placeholder="Session log remark…"
                value={remarkText}
                onChange={(e) => setRemarkText(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary field-sm"
                disabled={busyKey === 'end-run'}
                onClick={() => void endSession()}
              >
                {busyKey === 'end-run' ? 'Ending…' : 'End session'}
              </button>
            </div>
          ) : null}
        </div>
      </Card>

      <Kpis
        items={[
          { label: 'Present / Late', value: `${presentCount + lateCount}/${batchStudents.length}` },
          { label: 'Absent', value: absentSet.size },
          { label: 'Pre-test done', value: `${preDoneCount}/${batchStudents.length}` },
          { label: 'All hidden passed', value: allHiddenCount },
          { label: 'Live alerts', value: alerts.length },
        ]}
      />

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card title="Pre-test performance">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              role="img"
              aria-label={`Pre-test score distribution 0 to 5: ${analytics.histogram.join(', ')}`}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
                height: 110,
                borderBottom: '1px solid var(--border)',
                paddingBottom: 4,
              }}
            >
              {analytics.histogram.map((cnt, score) => (
                <div
                  key={score}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    height: '100%',
                    gap: 4,
                  }}
                >
                  <span className="mono" style={{ fontSize: 11 }}>
                    {cnt}
                  </span>
                  <div
                    style={{
                      width: '100%',
                      height: `${Math.max(4, Math.round((cnt / histMax) * 76))}px`,
                      borderRadius: '3px 3px 0 0',
                      background: score <= 2 ? 'var(--assist)' : 'var(--teal)',
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
              <span>0/5</span>
              <span>1</span>
              <span>2</span>
              <span>3</span>
              <span>4</span>
              <span>5/5</span>
            </div>

            {(['easy', 'medium', 'hard'] as const).map((lvl) => {
              const pct = analytics.byLevel[lvl];
              return (
                <div
                  key={lvl}
                  style={{ display: 'grid', gridTemplateColumns: '68px 1fr 40px', gap: 8, alignItems: 'center', fontSize: 12 }}
                >
                  <span style={{ textTransform: 'capitalize' }}>{lvl}</span>
                  <div style={{ height: 8, background: 'var(--border-soft)', borderRadius: 4 }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        borderRadius: 4,
                        background: pct < 60 ? 'var(--assist)' : 'var(--teal)',
                      }}
                    />
                  </div>
                  <span className="mono" style={{ textAlign: 'right' }}>
                    {pct}%
                  </span>
                </div>
              );
            })}

            <div style={{ fontSize: 12, color: 'var(--assist)' }}>{analytics.insight}</div>

            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              <strong>Skipped pre-test ({skippedPre.length}):</strong>{' '}
              {skippedPre.length === 0
                ? 'None'
                : skippedPre.map((s) => s.roll_no || s.full_name).join(', ')}
            </div>
          </div>
        </Card>

        <Card title={`Alerts (${alerts.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                No struggling or idle alerts right now.
              </div>
            ) : (
              alerts.map((al) => {
                const checked = selectedAlertIds.includes(al.studentId);
                return (
                  <label
                    key={al.studentId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: 8,
                      borderRadius: 5,
                      border: '1px solid var(--border-soft)',
                      background: al.kind === 'struggling' ? 'var(--assist-tint)' : 'var(--surface-alt)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedAlertIds((prev) =>
                          prev.includes(al.studentId)
                            ? prev.filter((id) => id !== al.studentId)
                            : [...prev, al.studentId],
                        )
                      }
                    />
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {al.rollNo}
                    </span>
                    <span style={{ flex: 1 }}>{al.detail}</span>
                    <Chip tone="warn">{al.kind}</Chip>
                  </label>
                );
              })
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="field field-sm"
                aria-label="Hint message"
                placeholder="Write a quick hint to selected students…"
                value={hintText}
                onChange={(e) => setHintText(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-teal field-sm"
                disabled={busyKey === 'send-hint' || selectedAlertIds.length === 0 || !hintText.trim()}
                onClick={() => void handleSendHint()}
              >
                Send hint to {selectedAlertIds.length}
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn field-sm" onClick={() => setTaModalOpen(true)}>
                Send TA to seats
              </button>
              <button
                type="button"
                className="btn field-sm"
                disabled={busyKey === 'flag-slow' || selectedAlertIds.length === 0}
                onClick={() => void handleFlagSlow()}
              >
                Add to slow-learner list
              </button>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Live monitor" flush>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Roll</th>
                <th>Student</th>
                <th>Attendance</th>
                <th>Q1</th>
                <th>Q2</th>
                <th style={{ textAlign: 'right' }}>Runs</th>
                <th style={{ textAlign: 'right' }}>Pre</th>
                <th style={{ textAlign: 'right' }}>Post</th>
                <th style={{ textAlign: 'right' }}>Viva /{course.rubric.viva}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batchStudents.map((stu) => {
                const stAtt = attMap.get(stu.id) ?? null;
                const isAbs = stAtt === 'absent';
                const q1St = qStatusLabel(stu.id, q1Id);
                const q2St = qStatusLabel(stu.id, q2Id);
                const runCnt = sessionSubs.filter((s) => s.student_id === stu.id).length;
                const preRow = preMap.get(stu.id);
                const postRow = postMap.get(stu.id);
                const savedViva = vivaMap.get(stu.id);
                const vivaInputVal =
                  vivaEdits.get(stu.id) ?? (savedViva !== undefined ? String(savedViva) : '');

                return (
                  <tr key={stu.id}>
                    <td className="mono">{stu.roll_no}</td>
                    <td>{stu.full_name}</td>
                    <td>
                      <Chip tone={stAtt ? statusTone(stAtt) : 'neutral'}>
                        {stAtt ?? 'unmarked'}
                      </Chip>
                    </td>
                    <td>
                      <Chip tone={q1St === 'All passed' ? 'good' : q1St === 'Visible passed' ? 'warn' : 'neutral'}>
                        {q1St}
                      </Chip>
                    </td>
                    <td>
                      <Chip tone={q2St === 'All passed' ? 'good' : q2St === 'Visible passed' ? 'warn' : 'neutral'}>
                        {q2St}
                      </Chip>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {runCnt}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {preRow?.submitted_at ? `${preRow.score ?? 0}/5` : '—'}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {postRow?.submitted_at ? `${postRow.score ?? 0}/5` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number"
                        aria-label={`Viva for ${stu.roll_no || stu.full_name}`}
                        className="field field-sm mono"
                        min={0}
                        max={course.rubric.viva}
                        step={0.5}
                        disabled={isAbs || !stAtt}
                        value={vivaInputVal}
                        onChange={(e) =>
                          setVivaEdits((prev) => new Map(prev).set(stu.id, e.target.value))
                        }
                        onBlur={(e) => {
                          if (e.target.value.trim()) {
                            void saveViva(stu.id, e.target.value);
                          }
                        }}
                        style={{ width: 64, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() => {
                          setInspectStudentId(stu.id);
                          setInspectSessionId(session.id);
                        }}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {inspectedStudent && liveData ? (
        (() => {
          const stuAttRows = liveData.allAttendance.filter((a) => a.student_id === inspectedStudent.id);
          const stuSubsAll = liveData.submissions.filter((s) => s.student_id === inspectedStudent.id);
          const stuAttemptsAll = liveData.allAttempts.filter((a) => a.student_id === inspectedStudent.id);
          const stuVivasAll = liveData.allVivas.filter((v) => v.student_id === inspectedStudent.id);

          const sessionTotals = allSessions.map((sess) => {
            const attRow = stuAttRows.find((a) =>
              liveData.run && sess.id === session.id ? a.session_run_id === liveData.run.id : true,
            );
            const preA = stuAttemptsAll.find((a) => a.session_id === sess.id && a.bank === 'pre');
            const postA = stuAttemptsAll.find((a) => a.session_id === sess.id && a.bank === 'post');
            const vRow = stuVivasAll.find((v) => v.session_id === sess.id);
            const sQs = sessionQuestions.filter((sq) => sq.session_id === sess.id);
            const qStats = sQs.map((sq) => {
              const qSubs = stuSubsAll.filter((sub) => sub.question_id === sq.question_id);
              return {
                visPassed: Math.max(0, ...qSubs.map((x) => x.visible_passed)),
                visTotal: Math.max(2, ...qSubs.map((x) => x.visible_total)),
                hidPassed: Math.max(0, ...qSubs.map((x) => x.hidden_passed)),
                hidTotal: Math.max(3, ...qSubs.map((x) => x.hidden_total)),
              };
            });
            return sessionMarks(
              {
                attendance: attRow?.state ?? null,
                preCorrect: preA?.score ?? 0,
                postCorrect: postA?.score ?? 0,
                questions: qStats,
                viva: Number(vRow?.marks ?? 0),
              },
              course.rubric,
            );
          });

          const selectedSessIdx = Math.max(
            0,
            allSessions.findIndex((s) => s.id === inspectSessionId),
          );
          const selectedBreakdown = sessionTotals[selectedSessIdx];
          const filteredSubs = stuSubsAll.filter((s) => s.session_id === inspectSessionId);
          const internalScore = internalOutOf100(sessionTotals.map((b) => b.total));
          const preSubmitted = stuAttemptsAll.filter((a) => a.bank === 'pre' && a.submitted_at);
          const postSubmitted = stuAttemptsAll.filter((a) => a.bank === 'post' && a.submitted_at);
          const avgPre = preSubmitted.length
            ? (preSubmitted.reduce((a, b) => a + (b.score ?? 0), 0) / preSubmitted.length).toFixed(1)
            : '0';
          const avgPost = postSubmitted.length
            ? (postSubmitted.reduce((a, b) => a + (b.score ?? 0), 0) / postSubmitted.length).toFixed(1)
            : '0';

          return (
            <Card
              title={`Student inspector · ${inspectedStudent.full_name} (${inspectedStudent.roll_no})`}
              actions={
                <button type="button" className="btn field-sm" onClick={() => setInspectStudentId(null)}>
                  Close
                </button>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Kpis
                  items={[
                    { label: 'Attendance', value: stuAttRows[0]?.state ?? '—' },
                    { label: 'Internal so far', value: `${internalScore}/100` },
                    { label: 'Sessions', value: allSessions.length },
                    { label: 'Avg pre · post', value: `${avgPre} · ${avgPost}` },
                    { label: 'Submissions', value: stuSubsAll.length },
                  ]}
                />

                <div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                    Day 1 to today · click a session
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {allSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`seg-btn ${s.id === inspectSessionId ? '' : ''}`}
                        aria-pressed={s.id === inspectSessionId}
                        onClick={() => setInspectSessionId(s.id)}
                        style={{
                          border: `1px solid ${s.id === inspectSessionId ? 'var(--ink)' : 'var(--border)'}`,
                          background: s.id === inspectSessionId ? 'var(--ink)' : 'var(--surface)',
                          color: s.id === inspectSessionId ? '#FFFFFF' : 'var(--ink)',
                        }}
                      >
                        S{s.n}
                      </button>
                    ))}
                  </div>
                </div>

                {selectedBreakdown ? (
                  <div className="mono" style={{ fontSize: 12, padding: 10, background: 'var(--surface-alt)', borderRadius: 5, border: '1px solid var(--border-soft)' }}>
                    Rubric S{selectedSessIdx + 1}: Att {selectedBreakdown.att} · Pre {selectedBreakdown.pre} · Post{' '}
                    {selectedBreakdown.post} · Vis {selectedBreakdown.vis} · Hid {selectedBreakdown.hid} · Viva{' '}
                    {selectedBreakdown.viva} = <strong>{selectedBreakdown.total} / {selectedBreakdown.outOf}</strong>
                  </div>
                ) : null}

                {filteredSubs.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                    No code runs recorded for this session.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filteredSubs.map((sub) => {
                      const codeShown = openCodeIds.has(sub.id);
                      return (
                        <div
                          key={sub.id}
                          style={{
                            border: '1px solid var(--border-soft)',
                            borderRadius: 5,
                            padding: 10,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                            <span className="mono">
                              {sub.mode} · {sub.lang} · Visible {sub.visible_passed}/{sub.visible_total} · Hidden{' '}
                              {sub.hidden_passed}/{sub.hidden_total} · {sub.verdict} · {formatTimeIst(sub.created_at)}
                            </span>
                            <button
                              type="button"
                              className="btn field-sm"
                              onClick={() =>
                                setOpenCodeIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(sub.id)) next.delete(sub.id);
                                  else next.add(sub.id);
                                  return next;
                                })
                              }
                            >
                              {codeShown ? 'Hide code' : 'Show code'}
                            </button>
                          </div>
                          {codeShown ? (
                            <pre
                              className="mono"
                              style={{
                                margin: 0,
                                padding: 10,
                                background: '#1B1B1A',
                                color: '#E8E6DF',
                                borderRadius: 4,
                                fontSize: 12,
                                overflowX: 'auto',
                              }}
                            >
                              {sub.code}
                            </pre>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          );
        })()
      ) : null}

      <Modal
        open={attModalOpen}
        title={`Attendance · S${session.n} (${batch.name})`}
        onClose={() => setAttModalOpen(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--muted)' }}>
            <span>Suggested from recent lab check-ins. Click a seat to cycle Present → Late → Absent.</span>
            <span className="mono" style={{ color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap' }}>
              P {attCountsInModal.p} · L {attCountsInModal.l} · A {attCountsInModal.a}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
              gap: 6,
            }}
          >
            {attEntries.map((entry) => {
              const toneStyle =
                entry.state === 'present'
                  ? { bg: 'var(--teal-tint)', fg: 'var(--teal)' }
                  : entry.state === 'late'
                    ? { bg: 'var(--assist-tint)', fg: 'var(--assist)' }
                    : { bg: 'var(--danger-tint)', fg: 'var(--danger)' };
              return (
                <button
                  key={entry.student_id}
                  type="button"
                  aria-label={`${entry.roll_no || entry.full_name}: ${entry.state}`}
                  onClick={() =>
                    setAttEntries((prev) =>
                      prev.map((row) =>
                        row.student_id === entry.student_id
                          ? { ...row, state: NEXT_STATE[row.state] }
                          : row,
                      ),
                    )
                  }
                  className="mono"
                  style={{
                    minHeight: 36,
                    border: '1px solid var(--border-soft)',
                    borderRadius: 5,
                    background: toneStyle.bg,
                    color: toneStyle.fg,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {entry.roll_no || entry.full_name}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)' }}>
            <span>Green: present</span>
            <span>Orange: late</span>
            <span>Red: absent</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setAttModalOpen(false)}>
              Later
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyKey === 'save-att' || attEntries.length === 0}
              onClick={() => void confirmAttendance()}
            >
              {busyKey === 'save-att' ? 'Saving…' : 'Confirm and open session'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={taModalOpen} title={`Send TA to seats · ${batch.name}`} onClose={() => setTaModalOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13 }}>
            <strong>Staff assigned:</strong> {batch.staff || 'Faculty + TA'} · {batch.room || 'Lab'}
          </div>
          <div style={{ fontSize: 13 }}>
            {selectedAlertIds.length > 0
              ? `Students needing attention: ${batchStudents
                  .filter((s) => selectedAlertIds.includes(s.id))
                  .map((s) => `${s.roll_no} (${s.full_name})`)
                  .join(', ')}`
              : `Open alerts in S${session.n}: ${
                  alerts.length > 0
                    ? alerts.map((a) => `${a.rollNo} (${a.kind})`).join(', ')
                    : 'No flagged students'
                }`}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const txt = `${batch.name} (${batch.staff}): check ${
                  alerts.map((a) => a.rollNo).join(', ') || 'all seats'
                }`;
                void navigator.clipboard?.writeText(txt);
                onNotify('TA seat summary copied.', true);
              }}
            >
              Copy
            </button>
            <button type="button" className="btn btn-primary" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function SessionsStep({
  course,
  batches,
  sessions,
  sessionRuns,
  enrollments,
  studentProfiles,
  sessionQuestions,
  initialSessionNumber,
  initialInspectRoll,
  onNotify,
  onRefresh,
}: {
  course: Course;
  batches: readonly Batch[];
  sessions: readonly SessionRow[];
  sessionRuns: readonly SessionRunRow[];
  enrollments: readonly Enrollment[];
  studentProfiles: readonly Profile[];
  sessionQuestions: readonly SessionQuestionRow[];
  initialSessionNumber?: number | null;
  initialInspectRoll?: string | null;
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const readySessions = sessions.filter((s) => s.status === 'active' || s.status === 'conducted');
  const [selectedBatchId, setSelectedBatchId] = useState<string>(batches[0]?.id ?? '');
  const [manualSessionId, setManualSessionId] = useState<string | null>(null);

  const selectedSessionId = (() => {
    if (manualSessionId && readySessions.some((s) => s.id === manualSessionId)) {
      return manualSessionId;
    }
    if (initialSessionNumber) {
      const target = readySessions.find((s) => s.n === initialSessionNumber);
      if (target) return target.id;
    }
    const today = todayIso();
    const todayHit = readySessions.find((s) => s.scheduled_date === today);
    return todayHit?.id ?? readySessions[0]?.id ?? '';
  })();

  if (batches.length === 0 || readySessions.length === 0) {
    return (
      <Empty
        title="No active sessions ready to run yet"
        body="Approve 2 lab questions (Step 4) and both test banks (Step 5) for at least one session first."
      />
    );
  }

  const activeBatch = batches.find((b) => b.id === selectedBatchId) ?? batches[0]!;
  const activeSession = readySessions.find((s) => s.id === selectedSessionId) ?? null;
  const today = todayIso();

  const enrolledIds = new Set(
    enrollments.filter((e) => e.batch_id === activeBatch.id).map((e) => e.student_id),
  );
  const batchStudents = studentProfiles
    .filter((p) => enrolledIds.has(p.id))
    .sort((a, b) => (a.roll_no ?? '').localeCompare(b.roll_no ?? ''));

  const matchingRun = activeSession
    ? sessionRuns.find((r) => r.session_id === activeSession.id && r.batch_id === activeBatch.id)
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Batches and sessions"
        actions={
          <Seg
            label="Select batch"
            options={batches.map((b) => ({ value: b.id, label: b.name }))}
            value={activeBatch.id}
            onChange={(val) => setSelectedBatchId(val)}
          />
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
            <span>{activeBatch.name} · click an active session to launch or monitor</span>
            <span>dark = completed · orange outline = today · light = ready · faint = not ready</span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))',
              gap: 6,
            }}
          >
            {sessions.map((s) => {
              const ready = s.status === 'active' || s.status === 'conducted';
              const isToday = s.scheduled_date === today;
              const isSelected = s.id === activeSession?.id;
              const bg =
                s.status === 'conducted'
                  ? 'var(--ink)'
                  : isToday && ready
                    ? 'var(--assist-tint)'
                    : ready
                      ? 'var(--surface)'
                      : 'var(--border-soft)';
              const fg =
                s.status === 'conducted'
                  ? '#FFFFFF'
                  : isToday && ready
                    ? 'var(--assist)'
                    : ready
                      ? 'var(--ink)'
                      : 'var(--faint)';

              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!ready}
                  aria-label={`Session ${s.n} ${s.topic} (${s.status})`}
                  aria-pressed={isSelected}
                  onClick={() => setManualSessionId(s.id)}
                  className="mono"
                  title={`${s.topic} · ${s.scheduled_date ? formatDateIst(s.scheduled_date) : ''}`}
                  style={{
                    minHeight: 34,
                    borderRadius: 4,
                    border: isToday && ready ? '2px solid var(--assist)' : '1px solid var(--border)',
                    background: bg,
                    color: fg,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: ready ? 'pointer' : 'not-allowed',
                    outline: isSelected ? '2px solid var(--teal)' : 'none',
                    outlineOffset: 1,
                  }}
                >
                  S{s.n}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {activeSession ? (
        <LiveSessionPanel
          key={`${activeSession.id}:${activeBatch.id}`}
          course={course}
          batch={activeBatch}
          session={activeSession}
          allSessions={sessions}
          sessionQuestions={sessionQuestions}
          existingRun={matchingRun}
          batchStudents={batchStudents}
          initialInspectRoll={initialInspectRoll}
          onNotify={onNotify}
          onRunCreated={onRefresh}
          onRefreshWorkspace={onRefresh}
        />
      ) : (
        <Banner tone="info">Select an active session above to launch attendance and the live monitor.</Banner>
      )}
    </div>
  );
}
