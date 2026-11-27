import { useState } from 'react';
import { Banner, Card, Chip, Empty } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import {
  orderRosterRows,
  parseRosterCsv,
  parseRosterGrid,
  splitRosterEvenly,
  validateRoster,
  type BatchOrderMode,
  type RosterRow,
} from '../../../lib/logic/roster';
import { buildRosterTemplateXlsx } from '../../../lib/logic/xlsxExport';
import { fn, rpc, supabase } from '../../../lib/supabase';
import type { Batch, Course, Enrollment, PendingEnrollment, Profile } from '../../../lib/types';

export function BatchesStep({
  course,
  institutionDomain,
  batches,
  enrollments,
  pendingEnrollments,
  studentProfiles,
  hasConductedSession,
  onNotify,
  onRefresh,
}: {
  course: Course;
  institutionDomain: string;
  batches: readonly Batch[];
  enrollments: readonly Enrollment[];
  pendingEnrollments: readonly PendingEnrollment[];
  studentProfiles: readonly Profile[];
  hasConductedSession: boolean;
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const [csvText, setCsvText] = useState('');
  const [allowPersonalEmails, setAllowPersonalEmails] = useState(false);
  const [batchOrder, setBatchOrder] = useState<BatchOrderMode>('prn_asc');
  const [maxPerBatch, setMaxPerBatch] = useState(65);
  const [parsedRows, setParsedRows] = useState<RosterRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [manualRoll, setManualRoll] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualBatchId, setManualBatchId] = useState('');
  const [batchEdits, setBatchEdits] = useState<
    Record<string, { slot: string; room: string; staff: string }>
  >({});
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [bulkTargetBatchId, setBulkTargetBatchId] = useState('');
  const [busy, setBusy] = useState(false);

  const profileMap = new Map(studentProfiles.map((p) => [p.id, p]));
  const totalStudents = enrollments.length + pendingEnrollments.length;
  const joinedCount = enrollments.length;
  const pendingCount = pendingEnrollments.length;

  function processRows(
    raw: RosterRow[],
    allowPersonal = allowPersonalEmails,
    orderMode = batchOrder,
  ) {
    const { valid, errors } = validateRoster(raw, institutionDomain, allowPersonal);
    setParsedRows(orderRosterRows(valid, orderMode));
    setParseErrors(errors);
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    setParseErrors([]);
    try {
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const { readSheet } = await import('read-excel-file/browser');
        const rows = await readSheet(file);
        processRows(parseRosterGrid(rows));
      } else {
        const text = await file.text();
        setCsvText(text);
        processRows(parseRosterCsv(text));
      }
    } catch (err) {
      setParseErrors([errorMessage(err)]);
    }
  }

  function handlePastePreview() {
    processRows(parseRosterCsv(csvText));
  }

  function downloadSampleTemplate() {
    const bytes = buildRosterTemplateXlsx(institutionDomain);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${course.code.toLowerCase()}-roster-template.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function confirmImport() {
    if (parsedRows.length === 0 || parseErrors.length > 0) return;
    setBusy(true);
    try {
      const created = await rpc<
        Array<{ batch_id: string; batch_name: string; class_code: string; student_count: number }>
      >('import_roster', {
        p_course_id: course.id,
        p_rows: parsedRows,
        p_allow_personal: allowPersonalEmails,
        p_max_per_batch: effectiveMaxPerBatch,
      });

      const batchCodeMap = new Map(created.map((b) => [b.batch_name, b.class_code]));
      const split = splitRosterEvenly(parsedRows, effectiveMaxPerBatch);
      const invitesPayload = split.flatMap((chunk, idx) => {
        const code = batchCodeMap.get(`Batch ${String.fromCharCode(65 + idx)}`) ?? created[0]?.class_code;
        return chunk.map((s) => ({
          email: s.email,
          fullName: s.full_name,
          role: 'student' as const,
          classCode: code,
        }));
      });

      let mailNote = '';
      if (invitesPayload.length > 0) {
        try {
          await fn('send-invites', {
            institutionId: course.institution_id,
            invites: invitesPayload.slice(0, 100),
          });
          mailNote = ' Invite emails queued.';
        } catch {
          mailNote = ' Roster and invites saved.';
        }
      }

      setParsedRows([]);
      setCsvText('');
      onNotify(`Imported ${parsedRows.length} students into ${created.length} batches.${mailNote}`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function inviteSingleStudent(e: React.FormEvent) {
    e.preventDefault();
    const cleanEmail = manualEmail.trim().toLowerCase();
    if (!manualRoll.trim() || !manualName.trim() || !cleanEmail) {
      onNotify('Enter roll number, full name, and student email.', false);
      return;
    }
    const dom = cleanEmail.split('@')[1] ?? '';
    if (dom !== institutionDomain.toLowerCase() && dom !== 'gmail.com' && dom !== 'outlook.com') {
      onNotify(`Only @${institutionDomain}, @gmail.com, or @outlook.com student emails are allowed.`, false);
      return;
    }
    setBusy(true);
    try {
      await rpc('faculty_invite_student', {
        p_course_id: course.id,
        p_batch_id: manualBatchId || batches[0]?.id || null,
        p_roll_no: manualRoll.trim(),
        p_full_name: manualName.trim(),
        p_email: cleanEmail,
      });
      try {
        await fn('send-invites', {
          institutionId: course.institution_id,
          invites: [
            {
              email: cleanEmail,
              fullName: manualName.trim(),
              role: 'student',
              classCode: (batches.find((b) => b.id === (manualBatchId || batches[0]?.id)) ?? batches[0])?.class_code,
            },
          ],
        });
      } catch {
        // Invite row already saved
      }
      setManualRoll('');
      setManualName('');
      setManualEmail('');
      onNotify(`Invited student ${cleanEmail}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function resendPendingInvites() {
    if (pendingEnrollments.length === 0) return;
    setBusy(true);
    try {
      const batchCodeById = new Map(batches.map((b) => [b.id, b.class_code]));
      await fn('send-invites', {
        institutionId: course.institution_id,
        invites: pendingEnrollments.slice(0, 100).map((pe) => ({
          email: pe.email,
          fullName: pe.full_name,
          role: 'student',
          classCode: batchCodeById.get(pe.batch_id),
        })),
      });
      onNotify(`Resent ${pendingEnrollments.length} pending invites with class codes.`, true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function saveBatchMeta(b: Batch) {
    const patch = batchEdits[b.id];
    if (!patch) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('batches')
        .update({ slot: patch.slot, room: patch.room, staff: patch.staff })
        .eq('id', b.id);
      if (error) throw new Error(error.message);
      onNotify(`Saved details for ${b.name}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function moveStudent(email: string, toBatchId: string) {
    setBusy(true);
    try {
      await rpc('move_student', {
        p_course_id: course.id,
        p_student_email: email,
        p_to_batch_id: toBatchId,
      });
      onNotify(`Moved ${email}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  function splitSelectedIds(keys: readonly string[]) {
    const enrollmentIds: string[] = [];
    const pendingIds: string[] = [];
    for (const k of keys) {
      if (k.startsWith('enr:')) enrollmentIds.push(k.slice(4));
      else if (k.startsWith('pend:')) pendingIds.push(k.slice(5));
    }
    return { enrollmentIds, pendingIds };
  }

  function toggleSelectKey(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  function toggleSelectBatch(batchMemberKeys: readonly string[]) {
    const allSelected =
      batchMemberKeys.length > 0 && batchMemberKeys.every((k) => selectedKeys.includes(k));
    setSelectedKeys((prev) => {
      if (allSelected) {
        return prev.filter((k) => !batchMemberKeys.includes(k));
      }
      const next = new Set(prev);
      for (const k of batchMemberKeys) next.add(k);
      return Array.from(next);
    });
  }

  async function moveSelectedStudents() {
    const targetId = bulkTargetBatchId || batches[0]?.id || '';
    if (!targetId || selectedKeys.length === 0) return;
    const { enrollmentIds, pendingIds } = splitSelectedIds(selectedKeys);
    setBusy(true);
    try {
      const moved = await rpc<number>('move_students_bulk', {
        p_course_id: course.id,
        p_enrollment_ids: enrollmentIds,
        p_pending_ids: pendingIds,
        p_to_batch_id: targetId,
      });
      const targetName = batches.find((b) => b.id === targetId)?.name ?? 'batch';
      setSelectedKeys([]);
      onNotify(`Moved ${moved} student(s) to ${targetName}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function removeStudentsByKeys(keys: readonly string[], label?: string) {
    if (keys.length === 0) return;
    const confirmMsg =
      label
        ? `Remove ${label} from this course?`
        : `Remove ${keys.length} selected student(s) from this course?`;
    if (!window.confirm(confirmMsg)) return;
    const { enrollmentIds, pendingIds } = splitSelectedIds(keys);
    setBusy(true);
    try {
      const removed = await rpc<number>('remove_course_students', {
        p_course_id: course.id,
        p_enrollment_ids: enrollmentIds,
        p_pending_ids: pendingIds,
      });
      setSelectedKeys((prev) => prev.filter((k) => !keys.includes(k)));
      onNotify(`Removed ${removed} student(s) from the course.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function deleteBatch(b: Batch, memberCount: number) {
    const extra = memberCount > 0 ? ` and unenroll its ${memberCount} student(s)` : '';
    if (!window.confirm(`Delete ${b.name}${extra}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await rpc('delete_course_batch', { p_batch_id: b.id });
      setSelectedKeys([]);
      onNotify(`Deleted ${b.name}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  const effectiveMaxPerBatch = Math.min(65, Math.max(1, Number.isFinite(maxPerBatch) ? maxPerBatch : 65));
  const previewSplit = splitRosterEvenly(parsedRows, effectiveMaxPerBatch);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Roster summary"
        actions={
          pendingCount > 0 ? (
            <button
              type="button"
              className="btn field-sm"
              disabled={busy}
              onClick={() => void resendPendingInvites()}
            >
              Resend {pendingCount} invites
            </button>
          ) : null
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', fontSize: 13 }}>
          <div>
            <strong>{totalStudents}</strong> students
          </div>
          <div>
            <Chip tone="good">{joinedCount} joined</Chip>
          </div>
          <div>
            <Chip tone={pendingCount > 0 ? 'warn' : 'neutral'}>{pendingCount} invites pending</Chip>
          </div>
          {batches.length > 0 ? (
            <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              Class codes: {batches.map((b) => `${b.name} ${b.class_code}`).join(' · ')}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Invite individual student (Institutional, Gmail, or Outlook)">
        <form onSubmit={inviteSingleStudent} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <label className="field-label">
            Roll no
            <input
              className="field mono"
              value={manualRoll}
              onChange={(e) => setManualRoll(e.target.value)}
              placeholder="2301044"
              style={{ width: 120 }}
            />
          </label>
          <label className="field-label" style={{ flex: '1 1 180px' }}>
            Full name
            <input
              className="field"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Student name"
            />
          </label>
          <label className="field-label" style={{ flex: '1 1 220px' }}>
            Student email (@{institutionDomain}, @gmail.com, @outlook.com)
            <input
              className="field"
              type="email"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              placeholder="student@gmail.com"
            />
          </label>
          {batches.length > 0 && (
            <label className="field-label">
              Batch
              <select
                className="field"
                value={manualBatchId || batches[0]?.id || ''}
                onChange={(e) => setManualBatchId(e.target.value)}
              >
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Send student invite
          </button>
        </form>
      </Card>

      <Card title="Import roster (CSV or Excel)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Columns: <span className="mono">roll_no, full_name, email</span> (@{institutionDomain}). Batches split
            evenly at most 65 students per batch.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
            <input
              type="file"
              aria-label="Upload roster file"
              accept=".csv,.tsv,.xlsx"
              disabled={hasConductedSession}
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="btn field-sm"
              onClick={downloadSampleTemplate}
            >
              Download sample template (Excel / CSV)
            </button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={allowPersonalEmails}
                onChange={(e) => {
                  const next = e.target.checked;
                  setAllowPersonalEmails(next);
                  if (csvText.trim()) processRows(parseRosterCsv(csvText), next);
                }}
              />
              Allow personal student emails (<code>gmail.com</code>, <code>outlook.com</code> only)
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <label className="field-label">
              Batch creation order
              <select
                className="field field-sm"
                disabled={hasConductedSession}
                value={batchOrder}
                onChange={(e) => {
                  const next = e.target.value as BatchOrderMode;
                  setBatchOrder(next);
                  if (parsedRows.length > 0) {
                    setParsedRows((prev) => orderRosterRows(prev, next));
                  }
                }}
              >
                <option value="prn_asc">PRN ascending (last 4 digits)</option>
                <option value="random">Randomly</option>
                <option value="upload">Keep upload order</option>
              </select>
            </label>
            <label className="field-label">
              Students per batch (max 65)
              <input
                type="number"
                className="field field-sm mono"
                min={1}
                max={65}
                disabled={hasConductedSession}
                value={maxPerBatch}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxPerBatch(Number.isFinite(v) ? Math.min(65, Math.max(1, Math.trunc(v))) : 65);
                }}
                style={{ width: 120 }}
              />
            </label>
          </div>

          <label className="field-label">
            Or paste CSV / TSV rows
            <textarea
              className="field mono"
              rows={4}
              disabled={hasConductedSession}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={'roll_no,full_name,email\n2301001,Aarav Patil,aarav@sanjivani.edu.in'}
              style={{ height: 'auto', padding: 8 }}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={!csvText.trim() || hasConductedSession}
              onClick={handlePastePreview}
            >
              Preview split
            </button>
          </div>

          {parseErrors.length > 0 ? (
            <Banner tone="err">
              {parseErrors.slice(0, 5).join(' ')}
              {parseErrors.length > 5 ? ` (+${parseErrors.length - 5} more)` : ''}
            </Banner>
          ) : null}

          {parsedRows.length > 0 && parseErrors.length === 0 ? (
            <div
              style={{
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--surface-alt)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Ready to import {parsedRows.length} students into {previewSplit.length} batch(es):{' '}
                <span className="mono">
                  {previewSplit
                    .map((chunk, i) => `Batch ${String.fromCharCode(65 + i)} (${chunk.length})`)
                    .join(' · ')}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  Confirm import and create batches
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {batches.length === 0 ? (
        <Empty
          title="No batches yet"
          body="Import a section roster above to split into batches of ≤ 65 and generate class codes."
        />
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input
                type="search"
                className="field"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Search students by roll no, name, or email…"
                style={{ width: 320, maxWidth: '100%' }}
              />
              {studentSearch.trim() ? (
                <button type="button" className="btn field-sm" onClick={() => setStudentSearch('')}>
                  Clear search
                </button>
              ) : null}
            </div>
            {selectedKeys.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Chip tone="neutral">{selectedKeys.length} selected</Chip>
                {batches.length > 1 ? (
                  <>
                    <select
                      aria-label="Target batch for selected students"
                      className="field field-sm"
                      disabled={hasConductedSession || busy}
                      value={bulkTargetBatchId || batches[0]?.id || ''}
                      onChange={(e) => setBulkTargetBatchId(e.target.value)}
                    >
                      {batches.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary field-sm"
                      disabled={hasConductedSession || busy}
                      onClick={() => void moveSelectedStudents()}
                    >
                      Move selected
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={hasConductedSession || busy}
                  onClick={() => void removeStudentsByKeys(selectedKeys)}
                >
                  Remove selected
                </button>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busy}
                  onClick={() => setSelectedKeys([])}
                >
                  Clear
                </button>
              </div>
            ) : null}
          </div>
          {batches.map((b) => {
          const curEdit = batchEdits[b.id] ?? { slot: b.slot, room: b.room, staff: b.staff };
          const batchEnrolled = enrollments
            .filter((e) => e.batch_id === b.id)
            .map((e) => {
              const p = profileMap.get(e.student_id);
              return {
                key: `enr:${e.id}`,
                roll: p?.roll_no ?? '—',
                name: p?.full_name ?? 'Student',
                email: p?.email ?? '',
                joined: true,
              };
            });
          const batchPending = pendingEnrollments
            .filter((pe) => pe.batch_id === b.id)
            .map((pe) => ({
              key: `pend:${pe.id}`,
              roll: pe.roll_no,
              name: pe.full_name,
              email: pe.email,
              joined: false,
            }));
          const allMembers = [...batchEnrolled, ...batchPending].sort((a, x) =>
            a.roll.localeCompare(x.roll),
          );
          const q = studentSearch.trim().toLowerCase();
          const members = q
            ? allMembers.filter(
                (m) =>
                  m.roll.toLowerCase().includes(q) ||
                  m.name.toLowerCase().includes(q) ||
                  m.email.toLowerCase().includes(q),
              )
            : allMembers;

          return (
            <Card
              key={b.id}
              title={
                q
                  ? `${b.name} · ${members.length} of ${allMembers.length} students`
                  : `${b.name} · ${allMembers.length} students`
              }
              actions={
                <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <Chip tone="neutral">Code: {b.class_code}</Chip>
                  <button
                    type="button"
                    className="btn field-sm"
                    disabled={hasConductedSession || busy}
                    onClick={() => void deleteBatch(b, allMembers.length)}
                  >
                    Delete batch
                  </button>
                </div>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                  <label className="field-label">
                    Slot
                    <input
                      className="field field-sm"
                      value={curEdit.slot}
                      onChange={(e) =>
                        setBatchEdits((prev) => ({
                          ...prev,
                          [b.id]: { ...curEdit, slot: e.target.value },
                        }))
                      }
                      style={{ width: 170 }}
                    />
                  </label>
                  <label className="field-label">
                    Room
                    <input
                      className="field field-sm"
                      value={curEdit.room}
                      onChange={(e) =>
                        setBatchEdits((prev) => ({
                          ...prev,
                          [b.id]: { ...curEdit, room: e.target.value },
                        }))
                      }
                      style={{ width: 110 }}
                    />
                  </label>
                  <label className="field-label">
                    Lab staff
                    <input
                      className="field field-sm"
                      value={curEdit.staff}
                      onChange={(e) =>
                        setBatchEdits((prev) => ({
                          ...prev,
                          [b.id]: { ...curEdit, staff: e.target.value },
                        }))
                      }
                      style={{ width: 170 }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn field-sm"
                    disabled={busy}
                    onClick={() => void saveBatchMeta(b)}
                  >
                    Save batch
                  </button>
                </div>

                {members.length > 0 ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}>
                            <input
                              type="checkbox"
                              aria-label={`Select all in ${b.name}`}
                              disabled={hasConductedSession || busy}
                              checked={
                                members.length > 0 &&
                                members.every((m) => selectedKeys.includes(m.key))
                              }
                              onChange={() =>
                                toggleSelectBatch(members.map((m) => m.key))
                              }
                            />
                          </th>
                          <th>Roll</th>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Status</th>
                          {batches.length > 1 ? <th style={{ textAlign: 'right' }}>Batch</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((m) => (
                          <tr key={m.key}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${m.email || m.name}`}
                                disabled={hasConductedSession || busy}
                                checked={selectedKeys.includes(m.key)}
                                onChange={() => toggleSelectKey(m.key)}
                              />
                            </td>
                            <td className="mono">{m.roll}</td>
                            <td>{m.name}</td>
                            <td className="mono" style={{ fontSize: 12 }}>
                              {m.email}
                            </td>
                            <td>
                              <Chip tone={m.joined ? 'good' : 'warn'}>
                                {m.joined ? 'Joined' : 'Invited'}
                              </Chip>
                            </td>
                            {batches.length > 1 ? (
                              <td style={{ textAlign: 'right' }}>
                                <select
                                  aria-label={`Move ${m.email || m.name} to batch`}
                                  className="field field-sm"
                                  disabled={hasConductedSession || busy || !m.email}
                                  value={b.id}
                                  onChange={(e) => {
                                    if (e.target.value !== b.id) {
                                      void moveStudent(m.email, e.target.value);
                                    }
                                  }}
                                >
                                  {batches.map((target) => (
                                    <option key={target.id} value={target.id}>
                                      {target.name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : q ? (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>No matching students in this batch.</p>
                ) : null}
              </div>
            </Card>
          );
        })}
        </>
      )}
    </div>
  );
}
