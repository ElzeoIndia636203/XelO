import { useState, type ChangeEvent } from 'react';
import { Banner, Card, Chip, Empty, Loading, Modal, Seg } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, formatTimeIst } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import { weekOf } from '../../../lib/logic/flows';
import { fn, fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  Batch,
  ClassAnswerKeyRow,
  ClassItemKind,
  ClassItemRow,
  ClassResponseRow,
  ClassTaskType,
  Course,
  Enrollment,
  PendingEnrollment,
  Profile,
  SessionRow,
} from '../../../lib/types';

const TASK_TYPE_OPTIONS: Array<{ value: ClassTaskType; label: string }> = [
  { value: 'quiz', label: 'MCQ quiz' },
  { value: 'fill', label: 'Fill in the code' },
  { value: 'predict', label: 'Predict the output' },
  { value: 'debug', label: 'Debug the code' },
  { value: 'assignment', label: 'Coding assignment' },
  { value: 'poll', label: 'Poll' },
];

const KIND_GLYPH: Record<ClassItemKind, { glyph: string; bg: string; fg: string }> = {
  announcement: { glyph: 'A', bg: '#EAEFF7', fg: '#23436E' },
  resource: { glyph: 'R', bg: '#F1EFE9', fg: '#6B6A63' },
  task: { glyph: 'T', bg: '#FFF4EC', fg: '#9A3412' },
};

function safeFileName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'resource';
}

export function ClassroomStep({
  course,
  batches,
  sessions,
  enrollments,
  pendingEnrollments,
  studentProfiles,
  onNotify,
  onRefresh,
}: {
  course: Course;
  batches: readonly Batch[];
  sessions: readonly SessionRow[];
  enrollments: readonly Enrollment[];
  pendingEnrollments: readonly PendingEnrollment[];
  studentProfiles: readonly Profile[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const { data, loading, error, reload } = useLoad(async () => {
    const items = await fetchAll<ClassItemRow>((from, to) =>
      supabase
        .from('class_items')
        .select('*')
        .eq('course_id', course.id)
        .order('week')
        .order('created_at')
        .range(from, to),
    );
    const itemIds = items.map((i) => i.id);
    const [keys, responses] =
      itemIds.length > 0
        ? await Promise.all([
            fetchAll<ClassAnswerKeyRow>((from, to) =>
              supabase.from('class_answer_keys').select('*').in('item_id', itemIds).range(from, to),
            ),
            fetchAll<ClassResponseRow>((from, to) =>
              supabase.from('class_responses').select('*').in('item_id', itemIds).range(from, to),
            ),
          ])
        : [[], []];
    return { items, keys, responses };
  }, [course.id]);

  const [composeWeek, setComposeWeek] = useState<number | null>(null);
  const [addKind, setAddKind] = useState<ClassItemKind>('task');
  const [taskType, setTaskType] = useState<ClassTaskType>('quiz');
  const [itemTitle, setItemTitle] = useState('');
  const [itemBody, setItemBody] = useState('');
  const [taskCode, setTaskCode] = useState('');
  const [optionsText, setOptionsText] = useState('Option A\nOption B\nOption C\nOption D');
  const [expectedKey, setExpectedKey] = useState('');
  const [resourceUrl, setResourceUrl] = useState('');
  const [uploadedFilePath, setUploadedFilePath] = useState<string | null>(null);
  const [aiPreviewKey, setAiPreviewKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [respModalItemId, setRespModalItemId] = useState<string | null>(null);

  // Build weeks dynamically from saved session schedule dates (2 sessions per lab week fallback)
  const weekBuckets = (() => {
    const groups = new Map<string, SessionRow[]>();
    const sorted = [...sessions].sort((a, b) => a.n - b.n);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      const k = s.scheduled_date ? weekOf(s.scheduled_date) : `week-${Math.floor(i / 2) + 1}`;
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    if (groups.size === 0) {
      groups.set('week-1', []);
    }
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const todayWeek = weekOf(todayIso);
    const arr = Array.from(groups.entries()).map(([key, sessList], idx) => {
      const firstDate = sessList.find((s) => s.scheduled_date)?.scheduled_date ?? null;
      const isNow =
        key === todayWeek ||
        sessList.some((s) => s.status === 'active') && !sessList.every((s) => s.status === 'conducted');
      const allDone = sessList.length > 0 && sessList.every((s) => s.status === 'conducted');
      return {
        weekNum: idx + 1,
        key,
        dateLabel: firstDate ? formatDateIst(firstDate) : `Week ${idx + 1}`,
        tag: isNow ? 'This week' : allDone ? 'Done' : 'Upcoming',
        isNow,
        sessions: sessList,
      };
    });
    return arr;
  })();

  function resetComposer() {
    setItemTitle('');
    setItemBody('');
    setTaskCode('');
    setOptionsText('Option A\nOption B\nOption C\nOption D');
    setExpectedKey('');
    setResourceUrl('');
    setUploadedFilePath(null);
    setAiPreviewKey(null);
  }

  function openComposer(weekNum: number) {
    setComposeWeek(weekNum);
    setAddKind('task');
    resetComposer();
  }

  async function handleResendInvites() {
    if (pendingEnrollments.length === 0) return;
    setBusyKey('resend');
    try {
      const batchMap = new Map(batches.map((b) => [b.id, b.class_code]));
      await fn('send-invites', {
        institutionId: course.institution_id,
        invites: pendingEnrollments.slice(0, 100).map((p) => ({
          email: p.email,
          fullName: p.full_name,
          role: 'student',
          classCode: batchMap.get(p.batch_id) ?? undefined,
        })),
      });
      onNotify(`Resent ${pendingEnrollments.length} pending student invite(s).`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleGenerateAiTask(weekNum: number, topic: string) {
    setBusyKey('ai-task');
    try {
      const res = await fn<{
        draft: {
          title: string;
          body: string;
          payload?: { code?: string; options?: string[] };
          answer_key?: { expected?: string };
        };
      }>('ai-generate', {
        kind: 'class_task',
        course_id: course.id,
        week: weekNum,
        task_type: taskType,
        topic: topic || course.title,
      });
      setItemTitle(res.draft.title);
      setItemBody(res.draft.body);
      setTaskCode(res.draft.payload?.code ?? '');
      if (res.draft.payload?.options && res.draft.payload.options.length > 0) {
        setOptionsText(res.draft.payload.options.join('\n'));
      }
      const keyVal = res.draft.answer_key?.expected ?? '';
      setExpectedKey(keyVal);
      setAiPreviewKey(keyVal || 'Auto-completion');
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDraftAnnouncement(topic: string) {
    setBusyKey('ai-ann');
    try {
      const res = await fn<{ draft: { title: string; body: string } }>('ai-generate', {
        kind: 'announcement',
        course_id: course.id,
        topic: topic || course.title,
      });
      setItemTitle(res.draft.title);
      setItemBody(res.draft.body);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleUploadResourceFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      onNotify('Resource file must be 20 MB or smaller.', false);
      return;
    }
    setBusyKey('upload-file');
    try {
      const path = `${course.id}/${Date.now()}-${safeFileName(file.name)}`;
      const { error: upErr } = await supabase.storage.from('class-files').upload(path, file, {
        upsert: false,
      });
      if (upErr) throw new Error(upErr.message);
      setUploadedFilePath(path);
      if (!itemTitle.trim()) {
        setItemTitle(file.name.replace(/\.[^.]+$/, ''));
      }
      onNotify(`Uploaded ${file.name} to private course storage.`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAddItem(weekNum: number) {
    setBusyKey('add-item');
    try {
      const title =
        itemTitle.trim() ||
        (addKind === 'task'
          ? TASK_TYPE_OPTIONS.find((t) => t.value === taskType)?.label ?? 'Class task'
          : addKind === 'announcement'
            ? 'Class announcement'
            : 'Course resource');

      const opts = optionsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      const payload =
        addKind === 'task'
          ? {
              ...(taskCode.trim() ? { code: taskCode } : {}),
              ...(taskType === 'quiz' || taskType === 'poll' ? { options: opts } : {}),
            }
          : {};

      const answerKey =
        addKind === 'task'
          ? {
              expected: expectedKey.trim(),
            }
          : null;

      await rpc('create_class_item', {
        p_course_id: course.id,
        p_week: weekNum,
        p_kind: addKind,
        p_task_type: addKind === 'task' ? taskType : null,
        p_title: title,
        p_body: itemBody.trim(),
        p_payload: payload,
        p_due_at: null,
        p_url: addKind === 'resource' && resourceUrl.trim() ? resourceUrl.trim() : null,
        p_file_path: addKind === 'resource' ? uploadedFilePath : null,
        p_answer_key: answerKey,
      });

      setComposeWeek(null);
      resetComposer();
      onNotify('Added to classroom timeline. Students in all batches see it now.', true);
      reload();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  const jumpTarget = weekBuckets.find((w) => w.isNow)?.weekNum ?? weekBuckets[0]?.weekNum ?? 1;
  const studentMap = new Map(studentProfiles.map((p) => [p.id, p]));
  const itemsByWeek = new Map<number, ClassItemRow[]>();
  for (const item of data?.items ?? []) {
    const arr = itemsByWeek.get(item.week) ?? [];
    arr.push(item);
    itemsByWeek.set(item.week, arr);
  }
  const keyMap = new Map((data?.keys ?? []).map((k) => [k.item_id, k]));
  const responsesByItem = new Map<string, ClassResponseRow[]>();
  for (const r of data?.responses ?? []) {
    const arr = responsesByItem.get(r.item_id) ?? [];
    arr.push(r);
    responsesByItem.set(r.item_id, arr);
  }

  const activeModalItem = (data?.items ?? []).find((i) => i.id === respModalItemId) ?? null;
  const activeModalResponses = activeModalItem ? (responsesByItem.get(activeModalItem.id) ?? []) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <span>
              Class codes{' '}
              <strong className="mono">
                {batches.map((b) => `${b.name}: ${b.class_code}`).join(' · ') || 'None yet'}
              </strong>
            </span>
            <span className="mono" style={{ color: 'var(--muted)' }}>
              {enrollments.length} students joined · {pendingEnrollments.length} invites pending
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {pendingEnrollments.length > 0 ? (
              <button
                type="button"
                className="btn field-sm"
                disabled={busyKey === 'resend'}
                onClick={() => void handleResendInvites()}
              >
                {busyKey === 'resend' ? 'Sending…' : `Resend ${pendingEnrollments.length} invites`}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary field-sm"
              onClick={() => {
                document.getElementById(`week-card-${jumpTarget}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              Jump to this week
            </button>
          </div>
        </div>
      </Card>

      {error ? <Banner tone="err">{errorMessage(new Error(error))}</Banner> : null}
      {loading && !data ? <Loading label="Loading classroom timeline…" /> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {weekBuckets.map((wk) => {
          const wkItems = itemsByWeek.get(wk.weekNum) ?? [];
          const topicsSummary = wk.sessions.map((s) => `S${s.n} ${s.topic}`).join(' · ') || `${course.code} Lab`;
          const isComposing = composeWeek === wk.weekNum;

          return (
            <div
              key={wk.key}
              id={`week-card-${wk.weekNum}`}
              className="timeline-row"
            >
              <div className="timeline-date">
                <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                  {wk.dateLabel}
                </div>
                <div style={{ fontSize: 11, color: wk.isNow ? 'var(--assist)' : 'var(--muted)', fontWeight: wk.isNow ? 600 : 400 }}>
                  {wk.tag}
                </div>
              </div>

              <div
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${wk.isNow ? 'var(--ink)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <strong>Week {wk.weekNum}</strong>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{topicsSummary}</span>
                </div>

                {wk.sessions.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '26px 1fr auto',
                      gap: 10,
                      alignItems: 'center',
                      padding: '8px 0',
                      borderTop: '1px solid var(--border-soft)',
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 600,
                        background: s.status === 'conducted' || s.status === 'active' ? 'var(--ink)' : 'var(--surface-alt)',
                        color: s.status === 'conducted' || s.status === 'active' ? '#FFFFFF' : 'var(--muted)',
                      }}
                    >
                      L
                    </span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        S{s.n} · {s.topic}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                        BTL L{s.btl} · {s.scheduled_date ? formatDateIst(s.scheduled_date) : 'Date pending'}
                      </div>
                    </div>
                    <Chip tone={s.status === 'conducted' ? 'good' : s.status === 'active' ? 'warn' : 'neutral'}>
                      {s.status === 'conducted' ? 'Conducted' : s.status === 'active' ? 'Active' : 'Planned'}
                    </Chip>
                  </div>
                ))}

                {wkItems.map((item) => {
                  const g = KIND_GLYPH[item.kind];
                  const resps = responsesByItem.get(item.id) ?? [];
                  const ansKey = keyMap.get(item.id);
                  return (
                    <div
                      key={item.id}
                      className="timeline-item-head"
                      style={{
                        padding: '8px 0',
                        borderTop: '1px solid var(--border-soft)',
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          width: 26,
                          height: 26,
                          flexShrink: 0,
                          borderRadius: 5,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                          fontWeight: 600,
                          background: g.bg,
                          color: g.fg,
                        }}
                      >
                        {g.glyph}
                      </span>
                      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
                        {item.body ? (
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{item.body}</div>
                        ) : null}
                        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {item.kind === 'task'
                            ? `${TASK_TYPE_OPTIONS.find((t) => t.value === item.task_type)?.label ?? 'Task'}${ansKey?.answer?.expected ? ` · Key: ${ansKey.answer.expected}` : ''}`
                            : item.kind === 'resource'
                              ? item.file_path
                                ? 'Private file'
                                : item.url ?? 'Resource'
                              : `Announcement · ${formatTimeIst(item.created_at)}`}
                        </div>
                      </div>
                      {item.kind === 'task' ? (
                        <button
                          type="button"
                          className="btn field-sm"
                          onClick={() => setRespModalItemId(item.id)}
                        >
                          Responses ({resps.length})
                        </button>
                      ) : (
                        <Chip tone="neutral">{item.kind}</Chip>
                      )}
                    </div>
                  );
                })}

                {isComposing ? (
                  <div
                    style={{
                      borderTop: '1px solid var(--border-soft)',
                      paddingTop: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <Seg
                      label="Classroom item kind"
                      options={[
                        { value: 'task', label: 'Task' },
                        { value: 'resource', label: 'Resource' },
                        { value: 'announcement', label: 'Announcement' },
                      ]}
                      value={addKind}
                      onChange={(k) => {
                        setAddKind(k as ClassItemKind);
                        setAiPreviewKey(null);
                      }}
                    />

                    {addKind === 'task' ? (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
                          <label className="field-label">
                            Task type
                            <select
                              className="field field-sm"
                              value={taskType}
                              onChange={(e) => setTaskType(e.target.value as ClassTaskType)}
                            >
                              {TASK_TYPE_OPTIONS.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="btn btn-teal field-sm"
                            disabled={busyKey === 'ai-task'}
                            onClick={() => void handleGenerateAiTask(wk.weekNum, topicsSummary)}
                          >
                            {busyKey === 'ai-task' ? 'Generating…' : 'Generate with AI'}
                          </button>
                        </div>

                        {aiPreviewKey !== null ? (
                          <div
                            style={{
                              padding: 10,
                              background: '#FFF4EC',
                              border: '1px solid #F3D1B9',
                              borderRadius: 5,
                              fontSize: 12,
                            }}
                          >
                            <strong style={{ color: '#9A3412' }}>Assist draft preview (review before adding)</strong>
                            <div style={{ marginTop: 4 }}>
                              Answer key: <span className="mono">{aiPreviewKey}</span>
                            </div>
                          </div>
                        ) : null}

                        <label className="field-label">
                          Title
                          <input
                            className="field field-sm"
                            value={itemTitle}
                            onChange={(e) => setItemTitle(e.target.value)}
                            placeholder="e.g. Predict loop output"
                          />
                        </label>
                        <label className="field-label">
                          Prompt
                          <textarea
                            className="field"
                            rows={2}
                            style={{ height: 'auto', padding: 8 }}
                            value={itemBody}
                            onChange={(e) => setItemBody(e.target.value)}
                          />
                        </label>
                        {['fill', 'predict', 'debug', 'assignment'].includes(taskType) ? (
                          <label className="field-label">
                            Code snippet
                            <textarea
                              className="field mono"
                              rows={3}
                              style={{ height: 'auto', padding: 8 }}
                              value={taskCode}
                              onChange={(e) => setTaskCode(e.target.value)}
                            />
                          </label>
                        ) : null}
                        {taskType === 'quiz' || taskType === 'poll' ? (
                          <label className="field-label">
                            Options (one per line)
                            <textarea
                              className="field"
                              rows={3}
                              style={{ height: 'auto', padding: 8 }}
                              value={optionsText}
                              onChange={(e) => setOptionsText(e.target.value)}
                            />
                          </label>
                        ) : null}
                        {taskType !== 'poll' ? (
                          <label className="field-label">
                            {taskType === 'quiz' ? 'Answer key (0-based option index)' : 'Expected answer key (faculty only)'}
                            <input
                              className="field field-sm mono"
                              value={expectedKey}
                              onChange={(e) => setExpectedKey(e.target.value)}
                              placeholder={taskType === 'quiz' ? '0' : 'Exact output or fix'}
                            />
                          </label>
                        ) : null}
                      </>
                    ) : null}

                    {addKind === 'resource' ? (
                      <>
                        <label className="field-label">
                          Resource title
                          <input
                            className="field field-sm"
                            value={itemTitle}
                            onChange={(e) => setItemTitle(e.target.value)}
                            placeholder="e.g. Arrays lab notes PDF"
                          />
                        </label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                          <label className="field-label" style={{ flex: '1 1 240px' }}>
                            External URL (https only)
                            <input
                              className="field field-sm"
                              value={resourceUrl}
                              onChange={(e) => setResourceUrl(e.target.value)}
                              placeholder="https://..."
                            />
                          </label>
                          <label className="btn field-sm" style={{ cursor: 'pointer' }}>
                            {busyKey === 'upload-file' ? 'Uploading…' : 'Upload private file (≤20 MB)'}
                            <input
                              type="file"
                              style={{ display: 'none' }}
                              onChange={(e) => void handleUploadResourceFile(e)}
                            />
                          </label>
                        </div>
                        {uploadedFilePath ? (
                          <div className="mono" style={{ fontSize: 11, color: 'var(--teal)' }}>
                            Stored: {uploadedFilePath}
                          </div>
                        ) : null}
                      </>
                    ) : null}

                    {addKind === 'announcement' ? (
                      <>
                        <label className="field-label">
                          Announcement title
                          <input
                            className="field field-sm"
                            value={itemTitle}
                            onChange={(e) => setItemTitle(e.target.value)}
                            placeholder="e.g. Pre-test closes at 09:59"
                          />
                        </label>
                        <label className="field-label">
                          Announcement body
                          <textarea
                            className="field"
                            rows={2}
                            style={{ height: 'auto', padding: 8 }}
                            value={itemBody}
                            onChange={(e) => setItemBody(e.target.value)}
                          />
                        </label>
                        <div>
                          <button
                            type="button"
                            className="btn field-sm"
                            disabled={busyKey === 'ai-ann'}
                            onClick={() => void handleDraftAnnouncement(topicsSummary)}
                          >
                            {busyKey === 'ai-ann' ? 'Drafting…' : 'Draft with Assist'}
                          </button>
                        </div>
                      </>
                    ) : null}

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-primary field-sm"
                        disabled={busyKey === 'add-item'}
                        onClick={() => void handleAddItem(wk.weekNum)}
                      >
                        {busyKey === 'add-item' ? 'Adding…' : 'Add to this week'}
                      </button>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() => {
                          setComposeWeek(null);
                          resetComposer();
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => openComposer(wk.weekNum)}
                      style={{
                        border: 0,
                        background: 'none',
                        padding: 0,
                        minHeight: 28,
                        color: 'var(--teal)',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      + Add task, resource or announcement
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={Boolean(activeModalItem)}
        title={activeModalItem ? `Responses · ${activeModalItem.title}` : 'Responses'}
        onClose={() => setRespModalItemId(null)}
      >
        {activeModalResponses.length === 0 ? (
          <Empty title="No student responses yet" body="Student submissions will appear here automatically." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Roll</th>
                  <th>Student</th>
                  <th>Answer</th>
                  <th style={{ textAlign: 'right' }}>Score</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {activeModalResponses.map((r) => {
                  const st = studentMap.get(r.student_id);
                  return (
                    <tr key={r.id}>
                      <td className="mono">{st?.roll_no ?? '—'}</td>
                      <td>{st?.full_name ?? r.student_id}</td>
                      <td className="mono">{r.answer.value ?? '—'}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {r.score ?? '—'}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {formatTimeIst(r.submitted_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
