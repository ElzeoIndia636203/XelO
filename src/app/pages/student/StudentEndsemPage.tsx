import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorNote, Loading, PageHead } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { isEligibleForEndsem, paperMarksBreakdown, type AssessmentRules } from '../../../lib/logic/endsem';
import {
  checkSingleMonitor,
  detectFacesInFrame,
  loadFaceDetector,
  requestCameraAndMic,
  requestEntireScreenShare,
  requestExamFullscreen,
} from '../../../lib/proctor-runtime';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import { StudentShell } from './StudentShell';

interface StudentAssessmentRow {
  id: string;
  course_id: string;
  batch_id: string;
  rules: AssessmentRules;
  stage: 'rules' | 'generate' | 'hod_pending' | 'scheduled' | 'live' | 'marks';
  scheduled_at: string | null;
  room: string;
  activated_at: string | null;
  ended_at: string | null;
  added_to_file: boolean;
}

interface CourseSummary {
  id: string;
  code: string;
  title: string;
  final_status: string;
}

interface ExamPaperSummary {
  id: string;
  q_ids: string[];
  submitted_at: string | null;
  flagged: boolean;
}

interface ExamSubRow {
  question_id: string;
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  marks: number;
}

export function StudentEndsemPage() {
  const { profile, institution } = useSession();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [assessment, setAssessment] = useState<StudentAssessmentRow | null>(null);
  const [paper, setPaper] = useState<ExamPaperSummary | null>(null);
  const [attPct, setAttPct] = useState(100);
  const [markedPresent, setMarkedPresent] = useState(false);
  const [subs, setSubs] = useState<ExamSubRow[]>([]);
  const [vivaMarks, setVivaMarks] = useState<number>(0);

  // S8 Secure check states
  const [inSecureCheck, setInSecureCheck] = useState(false);
  const [camOk, setCamOk] = useState(false);
  const [screenOk, setScreenOk] = useState(false);
  const [singleMonitorOk, setSingleMonitorOk] = useState(false);
  const [fullscreenOk, setFullscreenOk] = useState(false);
  const [faceOk, setFaceOk] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [starting, setStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const loadData = useCallback(async () => {
    if (!profile) return;
    setErr('');
    const { data: enrs, error: ee } = await supabase
      .from('enrollments')
      .select('course_id, batch_id')
      .eq('student_id', profile.id);
    if (ee) {
      setErr(errorMessage(ee));
      setLoading(false);
      return;
    }
    const enr = (enrs ?? [])[0] as { course_id: string; batch_id: string } | undefined;
    if (!enr) {
      setLoading(false);
      return;
    }

    const [{ data: cData }, { data: aData }, { data: statsData }] = await Promise.all([
      supabase.from('courses').select('id, code, title, final_status').eq('id', enr.course_id).single(),
      supabase
        .from('assessments')
        .select('*')
        .eq('course_id', enr.course_id)
        .eq('batch_id', enr.batch_id)
        .maybeSingle(),
      supabase.rpc('course_stats', { p_course_ids: [enr.course_id] }),
    ]);

    if (cData) setCourse(cData as CourseSummary);
    const statRow = ((statsData ?? []) as { attendance_pct?: number }[])[0];
    if (statRow?.attendance_pct !== undefined) setAttPct(Number(statRow.attendance_pct));

    const aRow = (aData as StudentAssessmentRow | null) ?? null;
    setAssessment(aRow);

    if (aRow) {
      const [{ data: attRow }, { data: paperRow }, { data: subRows }, { data: vivaRow }] = await Promise.all([
        supabase
          .from('attendance')
          .select('state')
          .eq('assessment_id', aRow.id)
          .eq('student_id', profile.id)
          .maybeSingle(),
        supabase
          .from('exam_papers')
          .select('id, q_ids, submitted_at, flagged')
          .eq('assessment_id', aRow.id)
          .eq('student_id', profile.id)
          .maybeSingle(),
        supabase
          .from('submissions')
          .select('question_id, visible_passed, visible_total, hidden_passed, hidden_total, marks')
          .eq('course_id', enr.course_id)
          .eq('student_id', profile.id)
          .eq('context', 'exam')
          .eq('mode', 'submit'),
        supabase
          .from('viva')
          .select('marks')
          .eq('assessment_id', aRow.id)
          .eq('student_id', profile.id)
          .maybeSingle(),
      ]);

      const st = (attRow as { state?: string } | null)?.state;
      setMarkedPresent(st === 'present' || st === 'late');
      setPaper((paperRow as ExamPaperSummary | null) ?? null);
      setSubs((subRows ?? []) as ExamSubRow[]);
      setVivaMarks(Number((vivaRow as { marks?: number } | null)?.marks ?? 0));
    }

    setLoading(false);
  }, [profile]);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadData();
    }, 0);
    return () => clearTimeout(id);
  }, [loadData]);

  // Waiting room polls every 5s for markedPresent + activated
  useEffect(() => {
    if (!inSecureCheck) return;
    const timer = setInterval(() => {
      void loadData();
    }, 5_000);
    return () => clearInterval(timer);
  }, [inSecureCheck, loadData]);

  async function runHardwareChecks() {
    setCheckMsg('');
    try {
      const camStream = await requestCameraAndMic();
      setCamOk(true);
      if (videoRef.current) {
        videoRef.current.srcObject = camStream;
        await videoRef.current.play().catch(() => undefined);
      }

      const { entireScreen } = await requestEntireScreenShare();
      setScreenOk(entireScreen);
      if (!entireScreen) {
        setCheckMsg('Please share your entire screen, not a single window or tab.');
        return;
      }

      const single = checkSingleMonitor();
      setSingleMonitorOk(single);
      if (!single) {
        setCheckMsg('Disconnect external monitors before starting the exam.');
        return;
      }

      const fs = await requestExamFullscreen();
      setFullscreenOk(fs);

      const detector = await loadFaceDetector();
      if (videoRef.current) {
        const faces = detectFacesInFrame(detector, videoRef.current);
        setFaceOk(faces === 1);
        if (faces !== 1) {
          setCheckMsg(faces === 0 ? 'No face detected in camera.' : 'Multiple faces detected.');
        }
      }
    } catch (e) {
      setCheckMsg(errorMessage(e));
    }
  }

  async function handleStartExam() {
    if (!assessment) return;
    setStarting(true);
    setErr('');
    const { data, error } = await supabase.rpc('start_exam', {
      p_assessment_id: assessment.id,
    });
    setStarting(false);
    if (error) {
      setErr(errorMessage(error));
      return;
    }
    const startedPaper = data as ExamPaperSummary;
    navigate(`/student/endsem/exam/${startedPaper.id}`);
  }

  const minAtt = institution?.min_attendance_pct ?? 75;
  const eligible = isEligibleForEndsem(attPct, minAtt);
  const showResults =
    Boolean(assessment?.added_to_file) &&
    (course?.final_status === 'hod_approved' || course?.final_status === 'coe_accepted');

  const allChecksPass =
    Boolean(profile) &&
    camOk &&
    screenOk &&
    singleMonitorOk &&
    fullscreenOk &&
    faceOk &&
    markedPresent &&
    assessment?.stage === 'live';

  if (loading) {
    return (
      <StudentShell activeTab="endsem">
        <Loading label="Loading end-sem practical…" />
      </StudentShell>
    );
  }

  if (!assessment || !course) {
    return (
      <StudentShell activeTab="endsem">
        <PageHead kicker="PRACTICAL EXAMINATION" title="End-sem practical" />
        <Empty title="No end-sem practical scheduled" body="Your batch assessment will appear here once scheduled by faculty." />
      </StudentShell>
    );
  }

  const breakdown = paperMarksBreakdown(assessment.rules);

  // S10: Results view
  if (showResults && paper) {
    const codingTotal = paper.q_ids.reduce((acc, qid) => {
      const sub = subs.find((s) => s.question_id === qid);
      return acc + (sub?.marks ?? 0);
    }, 0);
    const total = codingTotal + vivaMarks;
    return (
      <StudentShell activeTab="endsem">
        <PageHead
          kicker="PRACTICAL EXAMINATION"
          title={`End-sem result · ${course.code}`}
          lead="Published after HOD approval"
        />
        {err && <ErrorNote message={err} />}
        <Card title={`Total: ${total} / ${breakdown.total}`}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Question</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Visible tests</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Hidden tests</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Marks</th>
              </tr>
            </thead>
            <tbody>
              {paper.q_ids.map((qid, i) => {
                const sub = subs.find((s) => s.question_id === qid);
                return (
                  <tr key={qid} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px' }}>Question {i + 1}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {sub ? `${sub.visible_passed}/${sub.visible_total}` : '0/2'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {sub ? `${sub.hidden_passed}/${sub.hidden_total}` : '0/3'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{sub?.marks ?? 0}</td>
                  </tr>
                );
              })}
              <tr>
                <td colSpan={3} style={{ padding: '6px 8px', fontWeight: 600 }}>Viva</td>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{vivaMarks}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </StudentShell>
    );
  }

  // S8: Secure check & waiting room
  if (inSecureCheck) {
    const checks = [
      { label: 'SSO verified', ok: Boolean(profile) },
      { label: 'Camera and microphone', ok: camOk },
      { label: 'Entire-screen share', ok: screenOk },
      { label: 'Single monitor', ok: singleMonitorOk },
      { label: 'Fullscreen ready', ok: fullscreenOk },
      { label: 'Face detected', ok: faceOk },
      { label: 'Marked present by faculty', ok: markedPresent },
      { label: 'Test activated', ok: assessment.stage === 'live' },
    ];
    return (
      <StudentShell activeTab="endsem">
        <PageHead
          kicker="SECURE CHECK & WAITING ROOM"
          title={`${course.code} · ${course.title}`}
          lead="Complete all checks and wait for faculty activation. Polling every 5 s."
        />
        {err && <ErrorNote message={err} />}
        {checkMsg && <ErrorNote message={checkMsg} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <Card title="Pre-exam checklist">
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {checks.map((c) => (
                <li key={c.label} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{c.label}</span>
                  <strong style={{ color: c.ok ? '#16a34a' : 'var(--muted)' }}>{c.ok ? 'Pass' : 'Pending'}</strong>
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              By starting, you consent to webcam, microphone, entire-screen sharing, and event snapshot capture during the exam. Three warnings flag your attempt for faculty review.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn" onClick={runHardwareChecks}>
                Run device & face check
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!allChecksPass || starting}
                onClick={handleStartExam}
              >
                {starting ? 'Starting…' : 'Start exam'}
              </button>
            </div>
          </Card>
          <Card title="Camera preview">
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', borderRadius: 6, background: '#0f172a', minHeight: 180 }}
            />
          </Card>
        </div>
      </StudentShell>
    );
  }

  // S7: Before the day
  return (
    <StudentShell activeTab="endsem">
      <PageHead
        kicker="PRACTICAL EXAMINATION"
        title={`End-sem · ${course.code}`}
        lead={course.title}
      />
      {err && <ErrorNote message={err} />}
      <Card title="Schedule & eligibility">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 13, marginBottom: 16 }}>
          <div>
            <div style={{ color: 'var(--muted)' }}>Date & time</div>
            <strong>{assessment.scheduled_at ? new Date(assessment.scheduled_at).toLocaleString('en-IN') : 'TBA'}</strong>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>Room</div>
            <strong>{assessment.room || 'TBA'}</strong>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>Duration</div>
            <strong>{assessment.rules.duration_min} min</strong>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>Questions</div>
            <strong>{assessment.rules.questions_per_student}</strong>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Your attendance</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Institution minimum</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Eligibility</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Lab file</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: '6px 8px' }}>{attPct}%</td>
              <td style={{ padding: '6px 8px' }}>{minAtt}%</td>
              <td style={{ padding: '6px 8px', color: eligible ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                {eligible ? 'Eligible' : 'Below minimum'}
              </td>
              <td style={{ padding: '6px 8px' }}>
                <Link to="/student/lab-file">Open lab file</Link>
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          Rules: {assessment.rules.questions_per_student} coding questions ({breakdown.perQuestion} marks each) + {breakdown.viva} viva = {breakdown.total} marks. Fullscreen, webcam, and entire-screen sharing are required.
        </div>

        <button
          type="button"
          className="btn-primary"
          disabled={!eligible}
          onClick={() => setInSecureCheck(true)}
        >
          Open secure check & waiting room
        </button>
      </Card>
    </StudentShell>
  );
}
