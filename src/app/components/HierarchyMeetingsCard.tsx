import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card, Chip, TimePicker } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { formatDateTimeIst } from '../../lib/format';
import { useSession } from '../../lib/session';
import { rpc, supabase } from '../../lib/supabase';

interface ContactRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  relation: 'subordinate' | 'superior';
}

interface MeetingRow {
  id: string;
  requester_id: string;
  recipient_id: string;
  kind: 'notify' | 'meeting_request' | 'meeting_scheduled';
  title: string;
  scheduled_at: string | null;
  duration_minutes?: number;
  purpose?: string;
  note: string;
  status: 'pending' | 'accepted' | 'declined' | 'sent';
  created_at: string;
}

export function HierarchyMeetingsCard({
  title = 'Notifications & meetings',
  allowNotify = true,
  allowRequest = true,
}: {
  title?: string;
  allowNotify?: boolean;
  allowRequest?: boolean;
}) {
  const { profile } = useSession();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [recipientId, setRecipientId] = useState('');
  const [mode, setMode] = useState<'notify' | 'meeting_scheduled' | 'meeting_request'>(
    allowNotify ? 'meeting_scheduled' : 'meeting_request',
  );
  const [msgTitle, setMsgTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDates, setConfirmDates] = useState<Record<string, string>>({});
  const [confirmTimes, setConfirmTimes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);

  const loadData = useCallback(async () => {
    if (!profile?.id) return;
    const [cRes, mRes] = await Promise.all([
      rpc<ContactRow[]>('list_hierarchy_contacts').catch(() => [] as ContactRow[]),
      supabase
        .from('meetings')
        .select('id, requester_id, recipient_id, kind, title, scheduled_at, note, status, created_at')
        .or(`requester_id.eq.${profile.id},recipient_id.eq.${profile.id}`)
        .order('created_at', { ascending: false })
        .limit(30),
    ]);
    let contactsList = cRes ?? [];
    if (contactsList.length === 0 && profile.role === 'student') {
      contactsList = await rpc<ContactRow[]>('student_list_course_faculty').catch(() => [] as ContactRow[]);
    }
    setContacts(contactsList);
    if (!mRes.error && mRes.data) {
      setMeetings(mRes.data as MeetingRow[]);
    }
  }, [profile]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadData();
    }, 0);
    return () => clearTimeout(t);
  }, [loadData]);

  const filteredContacts = contacts.filter((c) =>
    mode === 'meeting_request' ? c.relation === 'superior' : c.relation === 'subordinate',
  );
  const activeRecipient =
    filteredContacts.find((c) => c.id === recipientId)?.id ?? filteredContacts[0]?.id ?? '';

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!activeRecipient || !msgTitle.trim()) {
      setFeedback({ text: 'Select a recipient and enter a subject.', ok: false });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await rpc('send_hierarchy_message', {
        p_recipient_id: activeRecipient,
        p_kind: mode,
        p_title: msgTitle.trim(),
        p_scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        p_note: note.trim(),
        p_course_id: null,
        p_duration_minutes: durationMinutes,
        p_purpose: purpose.trim(),
      });
      setMsgTitle('');
      setScheduledAt('');
      setPurpose('');
      setNote('');
      setFeedback({
        text:
          mode === 'meeting_request'
            ? 'Meeting request sent.'
            : mode === 'meeting_scheduled'
              ? 'Meeting scheduled and notified.'
              : 'Notification sent.',
        ok: true,
      });
      await loadData();
    } catch (err) {
      setFeedback({ text: errorMessage(err), ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function respond(m: MeetingRow, accept: boolean) {
    setBusy(true);
    try {
      let scheduledIso: string | null = null;
      if (accept) {
        const defaultIst = m.scheduled_at
          ? new Date(new Date(m.scheduled_at).getTime() + 330 * 60_000)
          : null;
        const dStr = confirmDates[m.id] ?? (defaultIst ? defaultIst.toISOString().slice(0, 10) : '');
        const tStr = confirmTimes[m.id] ?? (defaultIst ? defaultIst.toISOString().slice(11, 16) : '10:30');
        if (dStr) {
          scheduledIso = new Date(`${dStr}T${tStr || '10:30'}:00+05:30`).toISOString();
        }
      }
      await rpc('respond_meeting_request', {
        p_meeting_id: m.id,
        p_accept: accept,
        p_scheduled_at: scheduledIso,
      });
      setFeedback({
        text: accept
          ? 'Meeting confirmed and synced to both calendars.'
          : 'Meeting request declined.',
        ok: true,
      });
      await loadData();
    } catch (err) {
      setFeedback({ text: errorMessage(err), ok: false });
    } finally {
      setBusy(false);
    }
  }

  const contactById = new Map(contacts.map((c) => [c.id, c]));

  return (
    <Card title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {feedback ? (
          <div style={{ fontSize: 12, color: feedback.ok ? '#0E5E52' : '#dc2626' }}>
            {feedback.text}
          </div>
        ) : null}

        <form
          onSubmit={handleSend}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}
        >
          <label className="field-label">
            Action
            <select
              className="field"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as 'notify' | 'meeting_scheduled' | 'meeting_request');
                setRecipientId('');
              }}
            >
              {allowNotify ? <option value="meeting_scheduled">Schedule meeting</option> : null}
              {allowNotify ? <option value="notify">Send notification</option> : null}
              {allowRequest ? <option value="meeting_request">Request meeting</option> : null}
            </select>
          </label>
          <label className="field-label">
            Recipient
            <select
              className="field"
              value={activeRecipient}
              onChange={(e) => setRecipientId(e.target.value)}
              style={{ minWidth: 200 }}
            >
              {filteredContacts.length === 0 ? (
                <option value="">No eligible contacts</option>
              ) : null}
              {filteredContacts.map((c) => (
                <option key={`${c.id}-${c.relation}`} value={c.id}>
                  {c.full_name} ({c.role.toUpperCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="field-label" style={{ flex: '1 1 200px' }}>
            Subject
            <input
              className="field"
              value={msgTitle}
              onChange={(e) => setMsgTitle(e.target.value)}
              placeholder={mode === 'notify' ? 'Announcement or reminder' : 'Meeting agenda'}
            />
          </label>
          {mode !== 'notify' ? (
            <label className="field-label">
              Date & time
              <input
                className="field mono"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </label>
          ) : null}
          {mode !== 'notify' ? (
            <>
              <label className="field-label" style={{ flex: '1 1 180px' }}>
                Purpose
                <input
                  className="field"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="Meeting purpose / agenda"
                />
              </label>
              <label className="field-label">
                Duration
                <select
                  className="field"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                >
                  {[15, 30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <label className="field-label" style={{ flex: '1 1 200px' }}>
            Note
            <input
              className="field"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note or room link"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !activeRecipient}
          >
            {busy ? 'Sending…' : mode === 'meeting_request' ? 'Request' : mode === 'meeting_scheduled' ? 'Schedule' : 'Notify'}
          </button>
        </form>

        {meetings.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>With</th>
                  <th>When</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => {
                  const isIncoming = m.recipient_id === profile?.id;
                  const peerId = isIncoming ? m.requester_id : m.recipient_id;
                  const peer = contactById.get(peerId);
                  return (
                    <tr key={m.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{m.title}</div>
                        {m.purpose ? (
                          <div style={{ fontSize: 12 }}>Purpose: {m.purpose} {m.duration_minutes ? `(${m.duration_minutes} min)` : ''}</div>
                        ) : null}
                        {m.note ? (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.note}</div>
                        ) : null}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {isIncoming ? 'From ' : 'To '}
                        {peer ? `${peer.full_name} (${peer.role.toUpperCase()})` : peerId.slice(0, 8)}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {m.scheduled_at ? formatDateTimeIst(m.scheduled_at) : formatDateTimeIst(m.created_at)}
                      </td>
                      <td>
                        <Chip
                          tone={
                            m.status === 'accepted' || m.status === 'sent'
                              ? 'good'
                              : m.status === 'declined'
                                ? 'bad'
                                : 'warn'
                          }
                        >
                          {m.status}
                        </Chip>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isIncoming && m.kind === 'meeting_request' && m.status === 'pending' ? (() => {
                          const defaultIst = m.scheduled_at
                            ? new Date(new Date(m.scheduled_at).getTime() + 330 * 60_000)
                            : null;
                          const dVal = confirmDates[m.id] ?? (defaultIst ? defaultIst.toISOString().slice(0, 10) : '');
                          const tVal = confirmTimes[m.id] ?? (defaultIst ? defaultIst.toISOString().slice(11, 16) : '10:30');
                          return (
                            <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                              <input
                                type="date"
                                className="field field-sm mono"
                                value={dVal}
                                onChange={(e) => setConfirmDates((p) => ({ ...p, [m.id]: e.target.value }))}
                              />
                              <TimePicker
                                value={tVal}
                                onChange={(next) => setConfirmTimes((p) => ({ ...p, [m.id]: next }))}
                              />
                              <button
                                type="button"
                                className="btn btn-primary field-sm"
                                disabled={busy}
                                onClick={() => void respond(m, true)}
                              >
                                Confirm & accept
                              </button>
                              <button
                                type="button"
                                className="btn field-sm"
                                disabled={busy}
                                onClick={() => void respond(m, false)}
                              >
                                Decline
                              </button>
                            </div>
                          );
                        })() : (
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
