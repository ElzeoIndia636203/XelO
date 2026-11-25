import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorNote, Loading } from '../../../components/ui';
import { Workbench, type WorkbenchQuestion } from '../../../components/Workbench';
import { errorMessage } from '../../../lib/errors';
import {
  AUTOSAVE_INTERVAL_MS,
  FACE_CHECK_INTERVAL_MS,
  formatExamCountdown,
  NO_FACE_TRIGGER_MS,
  PROCTOR_WARNING_THRESHOLD,
  type ProctorEventKind,
} from '../../../lib/logic/proctor';
import {
  detectFacesInFrame,
  getProctorStreams,
  loadFaceDetector,
  stopProctorStreams,
} from '../../../lib/proctor-runtime';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import type { Course, DraftRow, QuestionRow, SubmissionRow, TestCaseRow } from '../../../lib/types';

interface PaperRow {
  id: string;
  assessment_id: string;
  student_id: string;
  q_ids: string[];
  deadline: string;
  submitted_at: string | null;
  flagged: boolean;
}

export function StudentProctoredIdePage() {
  const { paperId = '' } = useParams<{ paperId: string }>();
  const navigate = useNavigate();
  const { profile } = useSession();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [paper, setPaper] = useState<PaperRow | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [questions, setQuestions] = useState<WorkbenchQuestion[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);

  const [secondsLeft, setSecondsLeft] = useState(0);
  const [warnings, setWarnings] = useState(0);
  const [toast, setToast] = useState('');
  const [faceState, setFaceState] = useState<'ok' | 'none' | 'multi'>('ok');
  const [tabSwitches, setTabSwitches] = useState(0);
  const [fullscreenOk, setFullscreenOk] = useState(Boolean(document.fullscreenElement));
  const [saveState, setSaveState] = useState('Saved');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const noFaceSinceRef = useRef<number | null>(null);

  const loadExam = useCallback(async () => {
    if (!paperId || !profile) return;
    const { data: pData, error: pe } = await supabase
      .from('exam_papers')
      .select('*')
      .eq('id', paperId)
      .single();
    if (pe || !pData) {
      setErr(errorMessage(pe ?? 'not_found'));
      setLoading(false);
      return;
    }
    const p = pData as PaperRow;
    setPaper(p);

    const { data: assess } = await supabase
      .from('assessments')
      .select('course_id')
      .eq('id', p.assessment_id)
      .single();
    const courseId = (assess as { course_id: string } | null)?.course_id;
    if (!courseId) {
      setLoading(false);
      return;
    }

    const [{ data: cData }, { data: qRows }, { data: tcRows }, { data: dRows }, { data: sRows }] =
      await Promise.all([
        supabase.from('courses').select('*').eq('id', courseId).single(),
        supabase.from('questions').select('*').in('id', p.q_ids),
        supabase.from('test_cases').select('*').in('question_id', p.q_ids).eq('hidden', false).order('ord'),
        supabase.from('drafts').select('*').eq('student_id', profile.id).eq('context', 'exam').in('question_id', p.q_ids),
        supabase
          .from('submissions')
          .select('*')
          .eq('student_id', profile.id)
          .eq('context', 'exam')
          .in('question_id', p.q_ids),
      ]);

    setCourse(cData as Course | null);
    const tcs = (tcRows ?? []) as TestCaseRow[];
    const qList = (qRows ?? []) as QuestionRow[];
    const items: WorkbenchQuestion[] = [];
    for (const id of p.q_ids) {
      const q = qList.find((x) => x.id === id);
      if (q) {
        items.push({
          question: q,
          visibleTests: tcs.filter((t) => t.question_id === q.id),
          hiddenCount: 3,
        });
      }
    }
    setQuestions(items);
    setDrafts((dRows ?? []) as DraftRow[]);
    setSubmissions((sRows ?? []) as SubmissionRow[]);
    setLoading(false);
  }, [paperId, profile]);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadExam();
    }, 0);
    return () => clearTimeout(id);
  }, [loadExam]);

  const recordViolation = useCallback(
    async (type: ProctorEventKind, severity: number, detail: string) => {
      if (!paperId) return;
      const { data } = await supabase.rpc('log_proctor_event', {
        p_paper_id: paperId,
        p_type: type,
        p_severity: severity,
        p_detail: detail,
        p_snapshot_path: null,
      });
      const count = typeof data === 'number' ? data : warnings + 1;
      setWarnings(count);
      setToast(
        count >= PROCTOR_WARNING_THRESHOLD
          ? `Warning ${count}: attempt flagged for review (${detail}).`
          : `Warning ${count}: ${detail}`,
      );
    },
    [paperId, warnings],
  );

  // Attach camera stream from waiting room
  useEffect(() => {
    const { camStream } = getProctorStreams();
    if (videoRef.current && camStream) {
      videoRef.current.srcObject = camStream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [loading]);

  // Countdown timer
  useEffect(() => {
    if (!paper?.deadline) return;
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(paper.deadline).getTime() - Date.now()) / 1000));
      setSecondsLeft(diff);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [paper?.deadline]);

  // Face detection every 2s
  useEffect(() => {
    let active = true;
    const timer = setInterval(async () => {
      if (!active || !videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const detector = await loadFaceDetector();
        const faces = detectFacesInFrame(detector, videoRef.current);
        if (faces === 1) {
          setFaceState('ok');
          noFaceSinceRef.current = null;
        } else if (faces > 1) {
          setFaceState('multi');
          void recordViolation('multi_face', 2, 'Multiple faces detected');
        } else {
          setFaceState('none');
          if (noFaceSinceRef.current === null) {
            noFaceSinceRef.current = Date.now();
          } else if (Date.now() - noFaceSinceRef.current >= NO_FACE_TRIGGER_MS) {
            noFaceSinceRef.current = Date.now();
            void recordViolation('no_face', 2, 'No face detected for 10 s');
          }
        }
      } catch {
        // ignore if detector not loaded in mock env
      }
    }, FACE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [recordViolation]);

  // Lockdown listeners
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setTabSwitches((c) => c + 1);
        void recordViolation('tab_switch', 2, 'Tab switched or window hidden');
      }
    };
    const onFs = () => {
      const ok = Boolean(document.fullscreenElement);
      setFullscreenOk(ok);
      if (!ok) {
        void recordViolation('fullscreen_exit', 2, 'Exited fullscreen');
      }
    };
    const blockCopyPaste = (e: Event) => {
      e.preventDefault();
      void recordViolation('copy_paste', 1, 'Copy/paste blocked');
    };
    const blockContext = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase()))) {
        e.preventDefault();
        void recordViolation('devtools', 3, 'DevTools shortcut blocked');
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('copy', blockCopyPaste);
    document.addEventListener('paste', blockCopyPaste);
    document.addEventListener('cut', blockCopyPaste);
    document.addEventListener('contextmenu', blockContext);
    document.addEventListener('drop', blockContext);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('copy', blockCopyPaste);
      document.removeEventListener('paste', blockCopyPaste);
      document.removeEventListener('cut', blockCopyPaste);
      document.removeEventListener('contextmenu', blockContext);
      document.removeEventListener('drop', blockContext);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [recordViolation]);

  // Periodic save status heartbeat (10s)
  useEffect(() => {
    const timer = setInterval(() => {
      setSaveState('Saved');
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  async function handleSubmitExam() {
    if (!paper) return;
    const { error } = await supabase.rpc('submit_exam', { p_paper_id: paper.id });
    if (error) {
      setErr(errorMessage(error));
      return;
    }
    stopProctorStreams();
    navigate('/student/endsem');
  }

  if (loading) return <Loading label="Loading proctored exam…" />;
  if (err || !paper || !course) return <ErrorNote message={err || 'Exam paper not found.'} />;

  const { screenStream } = getProctorStreams();

  const draftMap = new Map<string, string>();
  for (const d of drafts) {
    draftMap.set(`${d.question_id}:${d.lang}`, d.code);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Proctor bar (no navigation) */}
      <header
        style={{
          background: '#1a1f2e',
          color: '#fff',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          fontSize: 12,
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: 64, height: 42, borderRadius: 4, background: '#0f172a', objectFit: 'cover' }}
        />
        <span>
          Faces: <strong>{faceState === 'ok' ? '1 detected' : faceState === 'none' ? 'None' : 'Multiple'}</strong>
        </span>
        <span>
          Screen: <strong>{screenStream?.active ? 'Shared' : 'Check'}</strong>
        </span>
        <span>
          Fullscreen: <strong>{fullscreenOk ? 'Yes' : 'Exited'}</strong>
        </span>
        <span>
          Tab switches: <strong>{tabSwitches}</strong>
        </span>
        <span>Copy/paste blocked</span>
        <span>
          Warnings: <strong>{warnings}/{PROCTOR_WARNING_THRESHOLD}</strong>
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700 }}>
          {formatExamCountdown(secondsLeft)}
        </span>
        <span style={{ color: '#94a3b8' }}>{saveState}</span>
        <button type="button" className="btn-primary" onClick={handleSubmitExam}>
          Submit exam
        </button>
      </header>

      {toast && (
        <div style={{ background: '#fef2f2', color: '#991b1b', padding: '8px 16px', fontSize: 13 }}>
          {toast}
        </div>
      )}

      <main style={{ flex: 1 }}>
        <Workbench
          mode="lab"
          runContext="exam"
          paperId={paper.id}
          title={`${course.code} · End-sem practical`}
          allowedLangs={course.allowed_langs}
          questions={questions}
          initialDrafts={draftMap}
          initialSubmissions={submissions}
          onSaveDraft={async (questionId, lang, code) => {
            setSaveState('Saving…');
            await supabase.rpc('save_draft', {
              p_question_id: questionId,
              p_context: 'exam',
              p_lang: lang,
              p_code: code,
            });
            setSaveState('Saved');
          }}
          onRunCompleted={() => void loadExam()}
          onExit={() => void handleSubmitExam()}
        />
      </main>
    </div>
  );
}
