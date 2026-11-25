import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorNote, Loading } from '../../../components/ui';
import { Workbench, type WorkbenchQuestion } from '../../../components/Workbench';
import { todayIso } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import type { SupportedLang } from '../../../lib/logic/starters';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  Course,
  DraftRow,
  Enrollment,
  NotificationRow,
  QuestionRow,
  SessionQuestionRow,
  SessionRow,
  SubmissionRow,
  TestAttemptRow,
  TestCaseRow,
} from '../../../lib/types';

export function StudentLabPage() {
  const { sessionId: paramSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const { profile } = useSession();
  const [liveHints, setLiveHints] = useState<NotificationRow[]>([]);

  const { data, loading, error, reload } = useLoad(async () => {
    const uid = profile?.id ?? '';
    let targetSessionId = paramSessionId ?? '';

    if (!targetSessionId) {
      const enrs = await fetchAll<Enrollment>((from, to) =>
        supabase.from('enrollments').select('*').eq('student_id', uid).range(from, to),
      );
      const courseIds = enrs.map((e) => e.course_id);
      if (courseIds.length === 0) throw new Error('not_found');
      const sessions = await fetchAll<SessionRow>((from, to) =>
        supabase.from('sessions').select('*').in('course_id', courseIds).in('status', ['active', 'conducted']).order('n').range(from, to),
      );
      const today = todayIso();
      const picked = sessions.find((s) => s.scheduled_date === today) ?? sessions[0];
      if (!picked) throw new Error('not_found');
      targetSessionId = picked.id;
    }

    // Record student lab check-in
    await rpc('lab_checkin', { p_session_id: targetSessionId }).catch(() => null);

    const { data: sess, error: sessErr } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', targetSessionId)
      .single<SessionRow>();
    if (sessErr || !sess) throw new Error(sessErr?.message ?? 'not_found');

    const [courseRes, sqRows, attempts, notifs] = await Promise.all([
      supabase.from('courses').select('*').eq('id', sess.course_id).single<Course>(),
      fetchAll<SessionQuestionRow>((from, to) =>
        supabase.from('session_questions').select('*').eq('session_id', sess.id).order('slot').range(from, to),
      ),
      fetchAll<TestAttemptRow>((from, to) =>
        supabase.from('test_attempts').select('*').eq('session_id', sess.id).eq('student_id', uid).range(from, to),
      ),
      fetchAll<NotificationRow>((from, to) =>
        supabase
          .from('notifications')
          .select('*')
          .eq('user_id', uid)
          .eq('kind', 'hint')
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
    ]);

    if (courseRes.error || !courseRes.data) {
      throw new Error(courseRes.error?.message ?? 'not_found');
    }

    const qIds = sqRows.map((sq) => sq.question_id);
    const [questions, visibleTests, hiddenCounts, drafts, submissions] =
      qIds.length > 0
        ? await Promise.all([
            fetchAll<QuestionRow>((from, to) =>
              supabase.from('questions').select('*').in('id', qIds).range(from, to),
            ),
            fetchAll<TestCaseRow>((from, to) =>
              supabase.from('test_cases').select('*').in('question_id', qIds).order('ord').range(from, to),
            ),
            rpc<Array<{ question_id: string; visible_count: number; hidden_count: number }>>(
              'hidden_test_counts',
              { p_question_ids: qIds },
            ),
            fetchAll<DraftRow>((from, to) =>
              supabase
                .from('drafts')
                .select('*')
                .eq('student_id', uid)
                .in('question_id', qIds)
                .eq('context', 'lab')
                .range(from, to),
            ),
            fetchAll<SubmissionRow>((from, to) =>
              supabase
                .from('submissions')
                .select('*')
                .eq('student_id', uid)
                .in('question_id', qIds)
                .order('created_at', { ascending: false })
                .range(from, to),
            ),
          ])
        : [[], [], [], [], []];

    const workbenchQuestions: WorkbenchQuestion[] = sqRows
      .map((sq) => {
        const q = questions.find((x) => x.id === sq.question_id);
        if (!q) return null;
        const vis = visibleTests.filter((t) => t.question_id === q.id && !t.hidden);
        const cnt = hiddenCounts.find((h) => h.question_id === q.id)?.hidden_count ?? 3;
        return { question: q, visibleTests: vis, hiddenCount: cnt };
      })
      .filter((x): x is WorkbenchQuestion => x !== null);

    const draftMap = new Map<string, string>();
    for (const d of drafts) {
      draftMap.set(`${d.question_id}:${d.lang}`, d.code);
    }

    return {
      session: sess,
      course: courseRes.data,
      workbenchQuestions,
      draftMap,
      submissions,
      preAttempt: attempts.find((a) => a.bank === 'pre') ?? null,
      postAttempt: attempts.find((a) => a.bank === 'post') ?? null,
      hints: notifs,
    };
  }, [paramSessionId, profile?.id]);

  // Live Realtime listener for incoming hint notifications
  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase
      .channel(`lab-hints-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile.id}` },
        (payload) => {
          const row = payload.new as NotificationRow;
          if (row.kind === 'hint') {
            setLiveHints((prev) => [row, ...prev]);
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profile?.id]);

  if (loading && !data) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Opening lab workspace…" />
      </main>
    );
  }

  if (error || !data) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <ErrorNote message={error ?? 'No active lab session found.'} />
      </main>
    );
  }

  const combinedHints = [...liveHints, ...data.hints].filter(
    (h, idx, arr) => arr.findIndex((x) => x.id === h.id) === idx,
  );

  return (
    <Workbench
      mode="lab"
      title={`${data.course.code} · S${data.session.n} ${data.session.topic}`}
      allowedLangs={data.course.allowed_langs}
      questions={data.workbenchQuestions}
      initialDrafts={data.draftMap}
      initialSubmissions={data.submissions}
      preAttempt={data.preAttempt}
      postAttempt={data.postAttempt}
      hints={combinedHints}
      sessionEndsLabel="Closes 23:59"
      onSaveDraft={async (questionId, lang: SupportedLang, code) => {
        await rpc('save_draft', {
          p_question_id: questionId,
          p_context: 'lab',
          p_lang: lang,
          p_code: code,
        });
      }}
      onRunCompleted={reload}
      onOpenPostTest={() => navigate(`/student/test/${data.session.id}/post`)}
      onExit={() => navigate('/student')}
    />
  );
}
