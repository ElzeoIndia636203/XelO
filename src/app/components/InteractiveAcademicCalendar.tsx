import { useCallback, useEffect, useState } from 'react';
import { Card } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { formatDateTimeIst } from '../../lib/format';
import { supabase } from '../../lib/supabase';

export interface CalendarMeetingItem {
  id: string;
  title: string;
  purpose: string;
  duration_minutes: number;
  scheduled_at: string;
  kind: string;
  status: string;
  other_name: string;
  other_role: string;
  is_requester: boolean;
}

interface ContactOption {
  id: string;
  full_name: string;
  email: string;
  role: string;
  relation: 'superior' | 'subordinate';
}

export interface CalendarOverlayEvent {
  day: string;
  kind: string;
  event_type?: string | null;
  label: string;
  no_attendance?: boolean;
}

export type CalendarSaturdayRule = 'all' | 'odd' | 'even' | 'none';

function isSaturdayHolidayForRule(isoDate: string, rule: CalendarSaturdayRule): boolean {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (dt.getUTCDay() !== 6) return false;
  if (rule === 'all') return true;
  if (rule === 'none') return false;
  const nth = Math.ceil(dt.getUTCDate() / 7);
  return rule === 'odd' ? nth % 2 === 1 : nth % 2 === 0;
}

function buildMonthGrid(ym: string): Array<string | null> {
  const [yStr, mStr] = ym.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return [];
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const offset = (firstDow + 6) % 7;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: offset }, () => null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${yStr}-${mStr}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function shiftMonth(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split('-');
  const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1 + delta, 1));
  return dt.toISOString().slice(0, 7);
}

export function InteractiveAcademicCalendar({
  title = 'Calendar & approved meetings',
  events = [],
  firstWorkingDay,
  lastWorkingDay,
  expectedEndsemDate,
  saturdayRule = 'none',
  initialMonth,
  onSelectDateForEvent,
  onJumpToNotifications,
}: {
  title?: string;
  events?: readonly CalendarOverlayEvent[];
  firstWorkingDay?: string;
  lastWorkingDay?: string;
  expectedEndsemDate?: string;
  saturdayRule?: CalendarSaturdayRule;
  initialMonth?: string;
  onSelectDateForEvent?: (isoDate: string) => void;
  onJumpToNotifications?: () => void;
}) {
  const [month, setMonth] = useState(() => initialMonth || new Date().toISOString().slice(0, 7));
  const [meetings, setMeetings] = useState<CalendarMeetingItem[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [timeStr, setTimeStr] = useState('10:30');
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const fetchCalendarData = useCallback(async () => {
    const [{ data: mData }, { data: cData }] = await Promise.all([
      supabase.rpc('calendar_approved_meetings'),
      supabase.rpc('list_hierarchy_contacts'),
    ]);
    return {
      meetings: (mData ?? []) as CalendarMeetingItem[],
      contacts: (cData ?? []) as ContactOption[],
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCalendarData().then((res) => {
      if (cancelled) return;
      setMeetings(res.meetings);
      setContacts(res.contacts);
      if (res.contacts.length > 0) {
        setRecipientId((prev) => prev || res.contacts[0]!.id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCalendarData]);

  async function submitMeetingFromDay(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDay || !recipientId || !meetingTitle.trim() || !purpose.trim()) {
      setMsg({ text: 'Select a contact and enter both title and purpose.', ok: false });
      return;
    }
    const target = contacts.find((c) => c.id === recipientId);
    if (!target) return;
    const kind = target.relation === 'superior' ? 'meeting_request' : 'meeting_scheduled';
    const scheduledIso = new Date(`${selectedDay}T${timeStr || '10:30'}:00+05:30`).toISOString();

    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc('send_hierarchy_message', {
      p_recipient_id: recipientId,
      p_kind: kind,
      p_title: meetingTitle.trim(),
      p_scheduled_at: scheduledIso,
      p_note: '',
      p_duration_minutes: duration,
      p_purpose: purpose.trim(),
    });
    setBusy(false);
    if (error) {
      setMsg({ text: errorMessage(error.message), ok: false });
      return;
    }
    setMeetingTitle('');
    setPurpose('');
    setMsg({
      text:
        kind === 'meeting_request'
          ? `Meeting request (${duration} min) sent to ${target.full_name} for ${selectedDay}.`
          : `Meeting scheduled (${duration} min) with ${target.full_name} on ${selectedDay}.`,
      ok: true,
    });
    const refreshed = await fetchCalendarData();
    setMeetings(refreshed.meetings);
  }

  function jumpNotifications() {
    if (onJumpToNotifications) {
      onJumpToNotifications();
      return;
    }
    const bell = document.querySelector<HTMLButtonElement>('button[aria-label^="Notifications"]');
    if (bell) {
      bell.scrollIntoView({ behavior: 'smooth', block: 'center' });
      bell.click();
    }
  }

  const dayMeetings = selectedDay
    ? meetings.filter((m) => m.scheduled_at.slice(0, 10) === selectedDay)
    : [];
  const dayEvents = selectedDay ? events.filter((ev) => ev.day === selectedDay) : [];

  return (
    <Card
      title={title}
      actions={
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn field-sm" onClick={jumpNotifications}>
            Notifications
          </button>
          <button type="button" className="btn field-sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            Prev
          </button>
          <span className="mono" style={{ fontSize: 12, minWidth: 74, textAlign: 'center' }}>
            {month}
          </span>
          <button type="button" className="btn field-sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            Next
          </button>
        </div>
      }
    >
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        Click any date to request or schedule a meeting (with purpose and duration), add an event, or view approved meetings.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="mono" style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '4px 0' }}>
            {d}
          </div>
        ))}
        {buildMonthGrid(month).map((iso, idx) => {
          if (!iso) {
            return <div key={`e-${idx}`} style={{ minHeight: 68, borderRadius: 6, background: 'rgba(0,0,0,0.02)' }} />;
          }
          const cellMeetings = meetings.filter((m) => m.scheduled_at.slice(0, 10) === iso);
          const cellEvents = events.filter((ev) => ev.day === iso);
          const isSelected = selectedDay === iso;
          const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
          const isSunday = dow === 0;
          const isSatHol = isSaturdayHolidayForRule(iso, saturdayRule);
          const inTerm = Boolean(firstWorkingDay && lastWorkingDay && iso >= firstWorkingDay && iso <= lastWorkingDay);
          const isFirst = firstWorkingDay === iso;
          const isLast = lastWorkingDay === iso;
          const isEndsem = expectedEndsemDate === iso;
          const cellBg =
            cellMeetings.length > 0
              ? '#E8F3F1'
              : cellEvents.some((e) => e.no_attendance)
                ? '#FFF2E6'
                : cellEvents.length > 0
                  ? '#E8F3F1'
                  : isSunday || isSatHol
                    ? '#F4F3EE'
                    : inTerm
                      ? '#FFFFFF'
                      : '#FAFAF8';
          return (
            <button
              key={iso}
              type="button"
              onClick={() => {
                setSelectedDay(iso);
                setMsg(null);
              }}
              style={{
                minHeight: 74,
                padding: 6,
                borderRadius: 6,
                textAlign: 'left',
                cursor: 'pointer',
                border: isSelected
                  ? '2px solid #0E5E52'
                  : isFirst || isLast || isEndsem
                    ? '1.5px solid #0E5E52'
                    : '1px solid var(--border)',
                background: cellBg,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                  {Number(iso.slice(8, 10))}
                </span>
                {(isSunday || isSatHol) && cellEvents.length === 0 && cellMeetings.length === 0 && (
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                    {isSunday ? 'Sun' : 'Sat off'}
                  </span>
                )}
              </div>
              {isFirst && <span style={{ fontSize: 10, color: '#0E5E52', fontWeight: 600 }}>First day</span>}
              {isLast && <span style={{ fontSize: 10, color: '#0E5E52', fontWeight: 600 }}>Last day</span>}
              {isEndsem && <span style={{ fontSize: 10, color: '#9A3412', fontWeight: 600 }}>End-sem</span>}
              {cellEvents.map((ev, i) => (
                <span key={i} style={{ fontSize: 10, color: ev.no_attendance ? '#9A3412' : '#0E5E52', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {ev.event_type ? `${ev.event_type}: ` : ''}
                  {ev.label}
                  {ev.no_attendance ? ' (No-att.)' : ''}
                </span>
              ))}
              {cellMeetings.map((mt) => (
                <span key={mt.id} style={{ fontSize: 10, color: '#0E5E52', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {mt.title} ({mt.duration_minutes}m)
                </span>
              ))}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong className="mono" style={{ fontSize: 13 }}>
              Selected date: {selectedDay}
            </strong>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              {onSelectDateForEvent && (
                <button type="button" className="btn field-sm" onClick={() => onSelectDateForEvent(selectedDay)}>
                  Add academic event on {selectedDay}
                </button>
              )}
              <button type="button" className="btn field-sm" onClick={jumpNotifications}>
                Jump to notifications
              </button>
              <button type="button" className="btn field-sm" onClick={() => setSelectedDay(null)}>
                Close
              </button>
            </div>
          </div>

          {dayEvents.length > 0 && (
            <div style={{ fontSize: 12, color: '#9A3412' }}>
              <strong>Events:</strong>{' '}
              {dayEvents.map((e) => `${e.event_type ? `${e.event_type}: ` : ''}${e.label}`).join(' · ')}
            </div>
          )}

          {dayMeetings.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Approved / scheduled meetings on {selectedDay}:</div>
              {dayMeetings.map((mt) => (
                <div key={mt.id} style={{ padding: 8, borderRadius: 6, background: '#FFFFFF', border: '1px solid var(--border)', fontSize: 12 }}>
                  <div>
                    <strong>{mt.title}</strong> · {formatDateTimeIst(mt.scheduled_at)} · <span className="mono">{mt.duration_minutes} min</span>
                  </div>
                  <div style={{ color: 'var(--muted)' }}>
                    With {mt.other_name} ({mt.other_role.toUpperCase()}) {mt.purpose ? `· Purpose: ${mt.purpose}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}

          {contacts.length > 0 && (
            <form onSubmit={submitMeetingFromDay} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <label className="field-label" style={{ minWidth: 200 }}>
                Contact
                <select className="field field-sm" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
                  {contacts.map((c) => (
                    <option key={`${c.id}-${c.relation}`} value={c.id}>
                      {c.full_name} ({c.role.toUpperCase()} · {c.relation === 'superior' ? 'Request' : 'Schedule'})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label" style={{ flex: '1 1 160px' }}>
                Meeting title
                <input className="field field-sm" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} placeholder="e.g. Lab doubt / Course review" />
              </label>
              <label className="field-label" style={{ flex: '1 1 200px' }}>
                Purpose
                <input className="field field-sm" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Reason / agenda for meeting" />
              </label>
              <label className="field-label">
                Time (IST)
                <input className="field field-sm mono" type="time" value={timeStr} onChange={(e) => setTimeStr(e.target.value)} />
              </label>
              <label className="field-label">
                Duration
                <select className="field field-sm" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {[15, 30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="btn btn-primary field-sm" disabled={busy}>
                {busy ? 'Sending…' : 'Send / Schedule'}
              </button>
            </form>
          )}

          {msg && (
            <div style={{ fontSize: 12, color: msg.ok ? '#0E5E52' : 'var(--bad)' }}>{msg.text}</div>
          )}
        </div>
      )}
    </Card>
  );
}
