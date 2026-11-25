import { useState, type FormEvent } from 'react';
import { Banner, Card, Chip, Empty, Kpis, Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst } from '../../../lib/format';
import { overlaps, parseMcqCsv } from '../../../lib/logic/flows';
import { fn, rpc } from '../../../lib/supabase';
import type { BankItemRow, BankType, Course, QuestionDifficulty, SessionRow } from '../../../lib/types';

const LEVELS: readonly QuestionDifficulty[] = ['easy', 'medium', 'hard'];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function isBankCompleteAndApproved(items: readonly BankItemRow[]): boolean {
  if (items.length !== 45 || !items.every((i) => i.approved)) return false;
  return (
    items.filter((i) => i.level === 'easy').length === 15 &&
    items.filter((i) => i.level === 'medium').length === 15 &&
    items.filter((i) => i.level === 'hard').length === 15
  );
}

function isBankDraftReady(items: readonly BankItemRow[]): boolean {
  if (items.length !== 45) return false;
  return (
    items.filter((i) => i.level === 'easy').length === 15 &&
    items.filter((i) => i.level === 'medium').length === 15 &&
    items.filter((i) => i.level === 'hard').length === 15
  );
}

export function TestBanksStep({
  course,
  sessions,
  bankItems,
  onNotify,
  onRefresh,
}: {
  course: Course;
  sessions: readonly SessionRow[];
  bankItems: readonly BankItemRow[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>(sessions[0]?.id ?? '');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Add/Edit bank item modal
  const [itemModal, setItemModal] = useState<{
    bank: BankType;
    level: QuestionDifficulty;
    editingId: string | null;
    stem: string;
    optionsText: string;
    answer: number;
  } | null>(null);
  const [itemErr, setItemErr] = useState<string | null>(null);

  if (course.plan_status !== 'approved' || sessions.length === 0) {
    return (
      <Empty
        title="Test banks unlock after course plan approval and session planning"
        body="Approve your course plan with the HOD and save your session dates first."
      />
    );
  }

  const activeSession = sessions.find((s) => s.id === selectedSessionId) ?? sessions[0]!;

  const itemsBySession = new Map<string, BankItemRow[]>();
  for (const b of bankItems) {
    const arr = itemsBySession.get(b.session_id) ?? [];
    arr.push(b);
    itemsBySession.set(b.session_id, arr);
  }

  const sessionState = (sid: string): 'active' | 'draft' | 'none' => {
    const list = itemsBySession.get(sid) ?? [];
    if (list.length === 0) return 'none';
    const pre = list.filter((i) => i.bank === 'pre');
    const post = list.filter((i) => i.bank === 'post');
    return isBankCompleteAndApproved(pre) && isBankCompleteAndApproved(post) ? 'active' : 'draft';
  };

  const activeCount = sessions.filter((s) => sessionState(s.id) === 'active').length;
  const awaitingApprovalCount = sessions.filter((s) => sessionState(s.id) === 'draft').length;
  const missingSessions = sessions.filter((s) => (itemsBySession.get(s.id) ?? []).length === 0);

  const curItems = itemsBySession.get(activeSession.id) ?? [];
  const curPre = curItems.filter((i) => i.bank === 'pre');
  const curPost = curItems.filter((i) => i.bank === 'post');
  const preApproved = isBankCompleteAndApproved(curPre);
  const postApproved = isBankCompleteAndApproved(curPost);

  const overlapList = overlaps(curPre, curPost);
  const collidingIds = new Set<string>([
    ...overlapList.map((o) => o.preId),
    ...overlapList.map((o) => o.postId),
  ]);

  const readyToApproveList = sessions.flatMap((s) => {
    const list = itemsBySession.get(s.id) ?? [];
    const pre = list.filter((i) => i.bank === 'pre');
    const post = list.filter((i) => i.bank === 'post');
    if (overlaps(pre, post).length > 0) return [];
    const jobs: Array<{ session: SessionRow; bank: BankType }> = [];
    if (!isBankCompleteAndApproved(pre) && isBankDraftReady(pre)) jobs.push({ session: s, bank: 'pre' });
    if (!isBankCompleteAndApproved(post) && isBankDraftReady(post)) jobs.push({ session: s, bank: 'post' });
    return jobs;
  });

  async function generateOne(session: SessionRow) {
    setBusyKey(`gen-${session.id}`);
    try {
      await fn('ai-generate', {
        kind: 'bank',
        course_id: course.id,
        session_id: session.id,
      });
      onNotify(`Drafted 45 pre-test and 45 post-test items for S${session.n}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function approveSingle(bank: BankType) {
    setBusyKey(`app-${bank}`);
    try {
      await rpc('approve_bank', {
        p_session_id: activeSession.id,
        p_bank: bank,
      });
      onNotify(`Approved ${bank}-test bank for S${activeSession.n}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function approveAllReady() {
    if (readyToApproveList.length === 0) return;
    setBusyKey('app-all');
    let count = 0;
    try {
      for (const job of readyToApproveList) {
        await rpc('approve_bank', { p_session_id: job.session.id, p_bank: job.bank });
        count++;
      }
      onNotify(`Approved ${count} ready bank(s).`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
      onRefresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function generateMissingAll() {
    if (missingSessions.length === 0) return;
    setBusyKey('gen-all');
    let count = 0;
    try {
      for (const s of missingSessions) {
        await fn('ai-generate', {
          kind: 'bank',
          course_id: course.id,
          session_id: s.id,
        });
        count++;
      }
      onNotify(`Generated banks for ${count} session(s).`, true);
      onRefresh();
    } catch (err) {
      const msg = errorMessage(err);
      onNotify(count > 0 ? `Stopped after ${count} session(s): ${msg}` : msg, false);
      onRefresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveItem(e: FormEvent) {
    e.preventDefault();
    if (!itemModal) return;
    setItemErr(null);
    const options = itemModal.optionsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (options.length < 2 || options.length > 6 || itemModal.answer < 0 || itemModal.answer >= options.length) {
      setItemErr('Provide 2 to 6 options and a valid answer index.');
      return;
    }

    setBusyKey('save-item');
    try {
      await rpc('upsert_bank_item', {
        p_session_id: activeSession.id,
        p_bank: itemModal.bank,
        p_level: itemModal.level,
        p_stem: itemModal.stem,
        p_options: options,
        p_answer: itemModal.answer,
        p_item_id: itemModal.editingId,
      });
      setItemModal(null);
      onNotify('Bank item saved.', true);
      onRefresh();
    } catch (err) {
      setItemErr(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteItem(itemId: string) {
    setBusyKey(`del-${itemId}`);
    try {
      await rpc('delete_bank_item', { p_item_id: itemId });
      onNotify('Item removed from bank.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCsvUpload(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMcqCsv(text);
      if (parsed.errors.length > 0) {
        onNotify(parsed.errors.slice(0, 3).join(' '), false);
        return;
      }
      await rpc('import_bank_items', {
        p_session_id: activeSession.id,
        p_items: parsed.rows,
      });
      onNotify(`Imported ${parsed.rows.length} MCQs into S${activeSession.n}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Kpis
        items={[
          { label: 'Active sessions with both banks', value: `${activeCount}/${sessions.length}` },
          { label: 'Awaiting approval', value: awaitingApprovalCount },
          { label: 'Pre / Post draw', value: '2E·2M·1H / 1E·2M·2H' },
          { label: 'Pre/post overlap', value: overlapList.length },
        ]}
      />

      <Card title="Select session">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))',
            gap: 6,
          }}
        >
          {sessions.map((s) => {
            const st = sessionState(s.id);
            const isSel = s.id === activeSession.id;
            const bg = st === 'active' ? 'var(--teal)' : st === 'draft' ? 'var(--assist-tint)' : 'var(--border-soft)';
            const fg = st === 'active' ? '#FFFFFF' : st === 'draft' ? 'var(--assist)' : 'var(--muted)';
            return (
              <button
                key={s.id}
                type="button"
                aria-label={`Session ${s.n} ${s.topic}: ${st}`}
                aria-pressed={isSel}
                onClick={() => setSelectedSessionId(s.id)}
                className="mono"
                style={{
                  minHeight: 34,
                  borderRadius: 4,
                  border: 0,
                  background: bg,
                  color: fg,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  outline: isSel ? '2px solid var(--ink)' : 'none',
                  outlineOffset: 1,
                }}
              >
                S{s.n}
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title={`S${activeSession.n} · ${activeSession.topic}`}
        actions={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {activeSession.scheduled_date ? formatDateIst(activeSession.scheduled_date) : 'Unscheduled'}
            </span>
            {overlapList.length > 0 ? (
              <Chip tone="warn">{overlapList.length} overlap(s) found</Chip>
            ) : (
              <Chip tone="neutral">0 overlaps</Chip>
            )}
            {preApproved && postApproved ? (
              <Chip tone={activeSession.status === 'active' ? 'good' : 'neutral'}>
                {activeSession.status === 'active' ? 'Active for all batches' : 'Both banks approved'}
              </Chip>
            ) : null}
          </div>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-assist field-sm"
            disabled={busyKey !== null}
            onClick={() => void generateOne(activeSession)}
          >
            {busyKey === `gen-${activeSession.id}` ? 'Generating…' : 'Generate with AI'}
          </button>

          {preApproved ? (
            <Chip tone="good">Pre-test approved</Chip>
          ) : (
            <button
              type="button"
              className="btn btn-teal field-sm"
              disabled={busyKey !== null}
              onClick={() => void approveSingle('pre')}
            >
              Approve pre-test bank
            </button>
          )}

          {postApproved ? (
            <Chip tone="good">Post-test approved</Chip>
          ) : (
            <button
              type="button"
              className="btn btn-teal field-sm"
              disabled={busyKey !== null}
              onClick={() => void approveSingle('post')}
            >
              Approve post-test bank
            </button>
          )}
        </div>
      </Card>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        {(['pre', 'post'] as const).map((bankKind) => {
          const bankList = bankKind === 'pre' ? curPre : curPost;
          const drawLabel = bankKind === 'pre' ? '45 · 2E 2M 1H per paper' : '45 · 1E 2M 2H per paper';
          return (
            <Card
              key={bankKind}
              title={bankKind === 'pre' ? 'Pre-test bank' : 'Post-test bank'}
              actions={<span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{drawLabel}</span>}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {LEVELS.map((lvl) => {
                  const items = bankList.filter((i) => i.level === lvl);
                  return (
                    <div key={lvl} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)' }}>
                          {lvl} · {items.length}/15
                        </span>
                        <button
                          type="button"
                          className="btn field-sm"
                          onClick={() => {
                            setItemErr(null);
                            setItemModal({
                              bank: bankKind,
                              level: lvl,
                              editingId: null,
                              stem: '',
                              optionsText: 'Option A\nOption B\nOption C\nOption D',
                              answer: 0,
                            });
                          }}
                        >
                          + Add {lvl}
                        </button>
                      </div>

                      {items.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>No {lvl} items yet.</div>
                      ) : (
                        items.map((it, idx) => {
                          const isOverlap = collidingIds.has(it.id);
                          return (
                            <div
                              key={it.id}
                              style={{
                                padding: 8,
                                borderRadius: 5,
                                border: `1px solid ${isOverlap ? 'var(--assist)' : 'var(--border-soft)'}`,
                                background: isOverlap ? 'var(--assist-tint)' : 'var(--surface)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                                fontSize: 13,
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span>
                                  <strong className="mono" style={{ color: 'var(--muted)', marginRight: 6 }}>
                                    {bankKind === 'pre' ? 'P' : 'Q'}{lvl[0]?.toUpperCase()}{idx + 1}
                                  </strong>
                                  {it.stem}
                                </span>
                                {isOverlap ? <Chip tone="warn">Overlaps the other bank</Chip> : null}
                              </div>
                              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                                {it.options.map((o, oi) => `${LETTERS[oi]}) ${o}`).join(' · ')} ·{' '}
                                <strong style={{ color: 'var(--teal)' }}>Ans: {LETTERS[it.answer]}</strong>
                              </div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn field-sm"
                                  onClick={() => {
                                    setItemErr(null);
                                    setItemModal({
                                      bank: bankKind,
                                      level: lvl,
                                      editingId: it.id,
                                      stem: it.stem,
                                      optionsText: it.options.join('\n'),
                                      answer: it.answer,
                                    });
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn field-sm"
                                  disabled={busyKey !== null}
                                  onClick={() => void handleDeleteItem(it.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="Bulk actions & CSV import">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyKey !== null || readyToApproveList.length === 0}
              onClick={() => void approveAllReady()}
            >
              {busyKey === 'app-all' ? 'Approving…' : `Approve ${readyToApproveList.length} ready banks`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busyKey !== null || missingSessions.length === 0}
              onClick={() => void generateMissingAll()}
            >
              {busyKey === 'gen-all'
                ? 'Generating…'
                : `Generate ${missingSessions.length} missing banks with Assist`}
            </button>
            <label className="btn" style={{ cursor: busyKey !== null ? 'not-allowed' : 'pointer' }}>
              Upload MCQs (CSV)
              <input
                type="file"
                accept=".csv,.txt"
                disabled={busyKey !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  void handleCsvUpload(f);
                }}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
            CSV format: stage (pre|post), level (easy|medium|hard), question, options (separated by |), answer (A–F)
          </div>
        </div>
      </Card>

      <Modal
        open={itemModal !== null}
        title={itemModal?.editingId ? `Edit ${itemModal.bank} MCQ` : `Add ${itemModal?.bank ?? ''} MCQ`}
        onClose={() => setItemModal(null)}
      >
        {itemModal ? (
          <form onSubmit={handleSaveItem} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {itemErr ? <Banner tone="err">{itemErr}</Banner> : null}
            <label className="field-label">
              Question stem
              <textarea
                className="field"
                rows={2}
                required
                value={itemModal.stem}
                onChange={(e) => setItemModal((p) => (p ? { ...p, stem: e.target.value } : p))}
                style={{ height: 'auto', padding: 8 }}
              />
            </label>
            <label className="field-label">
              Options (one per line, 2 to 6)
              <textarea
                className="field mono"
                rows={4}
                required
                value={itemModal.optionsText}
                onChange={(e) => setItemModal((p) => (p ? { ...p, optionsText: e.target.value } : p))}
                style={{ height: 'auto', padding: 8 }}
              />
            </label>
            <label className="field-label">
              Correct option (A–F)
              <select
                className="field mono"
                value={itemModal.answer}
                onChange={(e) => setItemModal((p) => (p ? { ...p, answer: Number(e.target.value) } : p))}
              >
                {LETTERS.map((l, idx) => (
                  <option key={l} value={idx}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setItemModal(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busyKey === 'save-item'}>
                {busyKey === 'save-item' ? 'Saving…' : 'Save item'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
