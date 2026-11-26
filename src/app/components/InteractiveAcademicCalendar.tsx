import { useCallback, useEffect, useState } from 'react';
import { Card } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { formatDateTimeIst } from '../../lib/format';
import { useSession } from '../../lib/session';
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

interface BusyDayItem {
  id: string;
  user_id: string;
  day: string;
  reason: string;
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
  events: eventsProp,
  firstWorkingDay: firstWorkingDayProp,
  lastWorkingDay: lastWorkingDayProp,
  expectedEndsemDate: expectedEndsemDateProp,
  saturdayRule: saturdayRuleProp,
  departmentId: departmentIdProp,
  viewUserId,
  viewUserLabel,
  defaultRecipientId,
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
  departmentId?: string | null;
  viewUserId?: string | null;
  viewUserLabel?: string;
  defaultRecipientId?: string;
  initialMonth?: string;
  onSelectDateForEvent?: (isoDate: string) => void;
  onJumpToNotifications?: () => void;
}) {
  const { profile } = useSession();
  const [month, setMonth] = useState(() => initialMonth || new Date().toISOString().slice(0, 7));
  const [meetings, setMeetings] = useState<CalendarMeetingItem[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [myBusyDays, setMyBusyDays] = useState<BusyDayItem[]>([]);
  const [recipientBusyDays, setRecipientBusyDays] = useState<BusyDayItem[]>([]);
  const [facultySessionEvents, setFacultySessionEvents] = useState<CalendarOverlayEvent[]>([]);
  const [loadedCal, setLoadedCal] = useState<{
    first_working_day?: string;
    last_working_day?: string;
    expected_endsem_date?: string | null;
    saturday_rule?: CalendarSaturdayRule;
    events: CalendarOverlayEvent[];
  } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<'meeting_request' | 'meeting_scheduled' | 'notify'>(() =>
    defaultRecipientId ? 'meeting_scheduled' : 'meeting_request',
  );
  const [recipientId, setRecipientId] = useState(defaultRecipientId ?? '');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busyReason, setBusyReason] = useState('Busy');
  const [timeStr, setTimeStr] = useState('10:30');
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const baseEvents = eventsProp ?? loadedCal?.events ?? [];
  const events = facultySessionEvents.length > 0 ? [...baseEvents, ...facultySessionEvents] : baseEvents;
  const firstWorkingDay = firstWorkingDayProp ?? loadedCal?.first_working_day;
  const lastWorkingDay = lastWorkingDayProp ?? loadedCal?.last_working_day;
  const expectedEndsemDate = expectedEndsemDateProp ?? loadedCal?.expected_endsem_date ?? undefined;
  const saturdayRule = saturdayRuleProp ?? loadedCal?.saturday_rule ?? 'none';

  const rolesList = profile?.roles?.length ? profile.roles : profile?.role ? [profile.role] : [];
  const canBlockBusy = rolesList.some((r) => ['faculty', 'hod', 'dean', 'coe', 'vc', 'super_admin'].includes(r));
  const hasSuperiors = contacts.some((c) => c.relation === 'superior');
  const hasSubordinates = contacts.some((c) => c.relation === 'subordinate');
  const effectiveMode =
    actionMode === 'meeting_request' && !hasSuperiors && hasSubordinates
      ? 'meeting_scheduled'
      : actionMode !== 'meeting_request' && !hasSubordinates && hasSuperiors
        ? 'meeting_request'
        : actionMode;
  const filteredContacts = contacts.filter((c) =>
    effectiveMode === 'meeting_request' ? c.relation === 'superior' : c.relation === 'subordinate',
  );
  const activeRecipient =
    filteredContacts.find((c) => c.id === recipientId)?.id ?? filteredContacts[0]?.id ?? '';

  const fetchCalendarData = useCallback(async () => {
    const targetUser = viewUserId || null;
    const [{ data: mData }, { data: cData, error: cErr }, { data: bData }, { data: fsData }] = await Promise.all([
      supabase.rpc('calendar_approved_meetings', targetUser ? { p_user_id: targetUser } : {}),
      supabase.rpc('list_hierarchy_contacts'),
      supabase.rpc('list_busy_days', targetUser ? { p_user_id: targetUser } : {}),
      targetUser
        ? supabase.rpc('faculty_calendar_sessions', { p_user_id: targetUser })
        : Promise.resolve({ data: [] as unknown[] }),
    ]);
    let calPayload: {
      first_working_day?: string;
      last_working_day?: string;
      expected_endsem_date?: string | null;
      saturday_rule?: CalendarSaturdayRule;
      events: CalendarOverlayEvent[];
    } | null = null;
    const effectiveDeptId = departmentIdProp ?? profile?.hod_department_id ?? profile?.department_id ?? null;
    if (eventsProp === undefined && profile?.institution_id) {
      let calQuery = supabase
        .from('academic_calendars')
        .select('id, first_working_day, last_working_day, expected_endsem_date, saturday_rule')
        .eq('approved', true)
        .eq('institution_id', profile.institution_id);
      if (effectiveDeptId) {
        calQuery = calQuery.eq('department_id', effectiveDeptId);
      }
      const { data: calRows } = await calQuery.limit(1);
      const calRow = (calRows?.[0] ?? null) as {
        id: string;
        first_working_day: string;
        last_working_day: string;
        expected_endsem_date: string | null;
        saturday_rule: CalendarSaturdayRule;
      } | null;
      if (calRow) {
        const { data: evRows } = await supabase
          .from('academic_calendar_events')
          .select('day, kind, event_type, label, no_attendance')
          .eq('calendar_id', calRow.id)
          .order('day');
        calPayload = {
          first_working_day: calRow.first_working_day,
          last_working_day: calRow.last_working_day,
          expected_endsem_date: calRow.expected_endsem_date,
          saturday_rule: calRow.saturday_rule,
          events: (evRows ?? []) as CalendarOverlayEvent[],
        };
      }
    }
    const sessEvents: CalendarOverlayEvent[] = Array.isArray(fsData)
      ? (fsData as Array<{ course_code: string; session_n: number; session_title: string; scheduled_date: string }>).map(
          (s) => ({
            day: s.scheduled_date,
            kind: 'academic_event',
            event_type: 'Lab',
            label: `${s.course_code} S${s.session_n}: ${s.session_title}`,
          }),
        )
      : [];
    return {
      meetings: (mData ?? []) as CalendarMeetingItem[],
      contacts: (cData ?? []) as ContactOption[],
      contactsErr: cErr ? errorMessage(cErr.message) : '',
      busyDays: (bData ?? []) as BusyDayItem[],
      sessionEvents: sessEvents,
      calPayload,
    };
  }, [departmentIdProp, eventsProp, profile, viewUserId]);

  useEffect(() => {
    let cancelled = false;
    void fetchCalendarData().then((res) => {
      if (cancelled) return;
      setMeetings(res.meetings);
      setContacts(res.contacts);
      setMyBusyDays(res.busyDays);
      setFacultySessionEvents(res.sessionEvents);
      if (res.contactsErr) {
        setMsg({ text: res.contactsErr, ok: false });
      }
      if (res.calPayload) {
        setLoadedCal(res.calPayload);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCalendarData]);

  useEffect(() => {
    let cancelled = false;
    if (effectiveMode !== 'meeting_request' || !activeRecipient) {
      return;
    }
    void supabase
      .rpc('list_busy_days', { p_user_id: activeRecipient })
      .then(({ data }) => {
        if (!cancelled && Array.isArray(data)) {
          setRecipientBusyDays(data as BusyDayItem[]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveMode, activeRecipient]);

  async function toggleBusyForSelectedDay() {
    if (!selectedDay) return;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc('toggle_busy_day', {
      p_day: selectedDay,
      p_reason: busyReason.trim() || 'Busy',
    });
    setBusy(false);
    if (error) {
      setMsg({ text: errorMessage(error.message), ok: false });
      return;
    }
    const nowBusy = Boolean(data);
    setMsg({
      text: nowBusy
        ? `Marked ${selectedDay} as Busy. Incoming meeting requests on this day are blocked.`
        : `Removed Busy block on ${selectedDay}.`,
      ok: true,
    });
    const refreshed = await fetchCalendarData();
    setMyBusyDays(refreshed.busyDays);
  }

  async function submitMeetingFromDay(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDay || !activeRecipient || !meetingTitle.trim() || (effectiveMode !== 'notify' && !purpose.trim())) {
      setMsg({ text: 'Select a contact and enter required subject/purpose.', ok: false });
      return;
    }
    const target = filteredContacts.find((c) => c.id === activeRecipient);
    if (!target) return;
    const scheduledIso =
      effectiveMode === 'notify'
        ? null
        : new Date(`${selectedDay}T${timeStr || '10:30'}:00+05:30`).toISOString();

    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc('send_hierarchy_message', {
      p_recipient_id: activeRecipient,
      p_kind: effectiveMode,
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
        effectiveMode === 'meeting_request'
          ? `Meeting request (${duration} min) sent to ${target.full_name} for ${selectedDay}.`
          : effectiveMode === 'meeting_scheduled'
            ? `Meeting scheduled (${duration} min) with ${target.full_name} on ${selectedDay}.`
            : `Notification sent to ${target.full_name}.`,
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
  const selectedDayBusy = selectedDay ? myBusyDays.find((b) => b.day === selectedDay) : undefined;
  const recipientBusyOnSelected =
    effectiveMode === 'meeting_request' && selectedDay
      ? recipientBusyDays.find((b) => b.day === selectedDay)
      : undefined;

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
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        {viewUserLabel
          ? `Viewing ${viewUserLabel}'s calendar (scheduled labs, busy days & meetings). Click any date to schedule a meeting.`
          : 'Click any date to request or schedule a meeting (with purpose and duration), add an event, or view approved meetings.'}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, fontSize: 11 }}>
        {[
          { label: 'First/Last day', bg: '#ECFDF5', border: '#059669', color: '#047857' },
          { label: 'End-sem', bg: '#F5F3FF', border: '#7C3AED', color: '#6D28D9' },
          { label: 'Internal exam', bg: '#FEF3C7', border: '#D97706', color: '#B45309' },
          { label: 'Holiday / Leave', bg: '#FFE4E6', border: '#E11D48', color: '#BE123C' },
          { label: 'Academic event', bg: '#E0F2FE', border: '#0284C7', color: '#0369A1' },
          { label: 'No-attendance', bg: '#FFEDD5', border: '#EA580C', color: '#C2410C' },
          { label: 'Approved meeting', bg: '#CCFBF1', border: '#0D9488', color: '#0F766E' },
          { label: 'Busy', bg: '#FEF9C3', border: '#CA8A04', color: '#854D0E' },
          { label: 'Sat off / Sun', bg: '#EEF2FF', border: '#C7D2FE', color: '#4338CA' },
        ].map((item) => (
          <span
            key={item.label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
              borderRadius: 999,
              background: item.bg,
              border: `1px solid ${item.border}`,
              color: item.color,
              fontWeight: 600,
            }}
          >
            {item.label}
          </span>
        ))}
      </div>

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
          const cellBusy = myBusyDays.find((b) => b.day === iso);
          const isSelected = selectedDay === iso;
          const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
          const isSunday = dow === 0;
          const isSatHol = isSaturdayHolidayForRule(iso, saturdayRule);
          const inTerm = Boolean(firstWorkingDay && lastWorkingDay && iso >= firstWorkingDay && iso <= lastWorkingDay);
          const isFirst = firstWorkingDay === iso;
          const isLast = lastWorkingDay === iso;
          const isEndsem = expectedEndsemDate === iso;
          const hasNoAtt = cellEvents.some((e) => e.no_attendance);
          const hasExam = cellEvents.some((e) => e.kind === 'internal_exam');
          const hasHoliday = cellEvents.some(
            (e) => e.kind === 'regional_holiday' || e.kind === 'other_holiday' || e.kind === 'leave',
          );
          const hasAcademicEv = cellEvents.some((e) => e.kind === 'academic_event');
          const cellBg =
            cellBusy
              ? '#FEF9C3'
              : cellMeetings.length > 0
                ? '#CCFBF1'
              : hasNoAtt
                ? '#FFEDD5'
                : hasExam
                  ? '#FEF3C7'
                  : hasHoliday
                    ? '#FFE4E6'
                    : hasAcademicEv
                      ? '#E0F2FE'
                      : isEndsem
                        ? '#F5F3FF'
                        : isFirst || isLast
                          ? '#ECFDF5'
                          : isSatHol
                            ? '#EEF2FF'
                            : isSunday
                              ? '#F1F5F9'
                              : inTerm
                                ? '#FFFFFF'
                                : '#FAFAF8';
          const cellBorder = isSelected
            ? '2px solid #0F766E'
            : cellMeetings.length > 0
              ? '1px solid #0D9488'
              : hasNoAtt
                ? '1px solid #EA580C'
                : hasExam
                  ? '1px solid #D97706'
                  : hasHoliday
                    ? '1px solid #E11D48'
                    : hasAcademicEv
                      ? '1px solid #0284C7'
                      : isEndsem
                        ? '1.5px solid #7C3AED'
                        : isFirst || isLast
                          ? '1.5px solid #059669'
                          : isSatHol
                            ? '1px solid #C7D2FE'
                            : '1px solid var(--border)';
          return (
            <button
              key={iso}
              type="button"
              onClick={() => {
                setSelectedDay(iso);
                setMsg(null);
              }}
              style={{
                minHeight: 78,
                padding: 6,
                borderRadius: 6,
                textAlign: 'left',
                cursor: 'pointer',
                border: cellBorder,
                background: cellBg,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: isSunday ? '#475569' : '#141413' }}>
                  {Number(iso.slice(8, 10))}
                </span>
                {(isSunday || isSatHol) && cellEvents.length === 0 && cellMeetings.length === 0 && (
                  <span style={{ fontSize: 10, fontWeight: 600, color: isSatHol ? '#4338CA' : '#64748B' }}>
                    {isSunday ? 'Sun' : 'Sat off'}
                  </span>
                )}
              </div>
              {isFirst && <span style={{ fontSize: 10, color: '#047857', fontWeight: 700 }}>First day</span>}
              {isLast && <span style={{ fontSize: 10, color: '#047857', fontWeight: 700 }}>Last day</span>}
              {isEndsem && <span style={{ fontSize: 10, color: '#6D28D9', fontWeight: 700 }}>End-sem</span>}
              {cellEvents.map((ev, i) => {
                const evColor = ev.no_attendance
                  ? '#C2410C'
                  : ev.kind === 'internal_exam'
                    ? '#B45309'
                    : ev.kind === 'academic_event'
                      ? '#0369A1'
                      : '#BE123C';
                return (
                  <span key={i} style={{ fontSize: 10, color: evColor, fontWeight: 700, overflowWrap: 'anywhere' }}>
                    {ev.event_type ? `${ev.event_type}: ` : ''}
                    {ev.label}
                    {ev.no_attendance ? ' (No-att.)' : ''}
                  </span>
                );
              })}
              {cellMeetings.map((mt) => (
                <span key={mt.id} style={{ fontSize: 10, color: '#0F766E', fontWeight: 700, overflowWrap: 'anywhere' }}>
                  {mt.title} ({mt.duration_minutes}m)
                </span>
              ))}
              {cellBusy && (
                <span style={{ fontSize: 10, color: '#854D0E', fontWeight: 700, overflowWrap: 'anywhere' }}>
                  Busy: {cellBusy.reason}
                </span>
              )}
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

          {canBlockBusy && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 8, borderRadius: 6, background: '#FEF9C3', border: '1px solid #CA8A04' }}>
              {selectedDayBusy ? (
                <>
                  <span style={{ fontSize: 12, color: '#854D0E', fontWeight: 600 }}>
                    You blocked {selectedDay} as Busy ({selectedDayBusy.reason}) — incoming meeting requests are blocked.
                  </span>
                  <button type="button" className="btn field-sm" disabled={busy} onClick={() => void toggleBusyForSelectedDay()}>
                    Unblock Busy day
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="field field-sm"
                    value={busyReason}
                    onChange={(e) => setBusyReason(e.target.value)}
                    placeholder="Reason (e.g. Lab Evaluation / Out of office)"
                    style={{ flex: '1 1 200px' }}
                  />
                  <button type="button" className="btn field-sm" disabled={busy} onClick={() => void toggleBusyForSelectedDay()}>
                    Block day as Busy
                  </button>
                </>
              )}
            </div>
          )}

          {contacts.length > 0 ? (
            <form onSubmit={submitMeetingFromDay} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
                <label className="field-label">
                  Action
                  <select
                    className="field field-sm"
                    value={effectiveMode}
                    onChange={(e) => setActionMode(e.target.value as 'meeting_request' | 'meeting_scheduled' | 'notify')}
                  >
                    {hasSuperiors && <option value="meeting_request">Request meeting (Higher hierarchy)</option>}
                    {hasSubordinates && <option value="meeting_scheduled">Schedule meeting (Lower hierarchy)</option>}
                    {hasSubordinates && <option value="notify">Send notification (Lower hierarchy)</option>}
                  </select>
                </label>
                <label className="field-label" style={{ minWidth: 200 }}>
                  Recipient
                  <select className="field field-sm" value={activeRecipient} onChange={(e) => setRecipientId(e.target.value)}>
                    {filteredContacts.length === 0 ? (
                      <option value="">No eligible contacts</option>
                    ) : (
                      filteredContacts.map((c) => (
                        <option key={`${c.id}-${c.relation}`} value={c.id}>
                          {c.full_name} ({c.role.toUpperCase()})
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="field-label" style={{ flex: '1 1 160px' }}>
                  {effectiveMode === 'notify' ? 'Subject' : 'Meeting title'}
                  <input className="field field-sm" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} placeholder="e.g. Lab doubt / Course review" />
                </label>
                {effectiveMode !== 'notify' && (
                  <>
                    <label className="field-label" style={{ flex: '1 1 180px' }}>
                      Purpose
                      <input className="field field-sm" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Reason / agenda" />
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
                  </>
                )}
                <button type="submit" className="btn btn-primary field-sm" disabled={busy || !activeRecipient || Boolean(recipientBusyOnSelected)}>
                  {busy ? 'Sending…' : effectiveMode === 'meeting_request' ? 'Request' : effectiveMode === 'meeting_scheduled' ? 'Schedule' : 'Notify'}
                </button>
              </div>
              {recipientBusyOnSelected && (
                <div style={{ fontSize: 12, color: '#B45309', fontWeight: 600 }}>
                  This recipient has blocked {selectedDay} as Busy ({recipientBusyOnSelected.reason}). Meeting requests cannot be placed on this day.
                </div>
              )}
            </form>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              No hierarchy contacts available to schedule/request a meeting yet. Ensure migrations are pushed and Faculty / Dean / CoE / VC accounts exist in your institution.
            </div>
          )}

          {msg && (
            <div style={{ fontSize: 12, color: msg.ok ? '#0E5E52' : 'var(--bad)' }}>{msg.text}</div>
          )}
        </div>
      )}
    </Card>
  );
}
