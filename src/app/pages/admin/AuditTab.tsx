import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Chip, Empty } from '../../../components/ui';
import { formatDateTimeIst, todayIso } from '../../../lib/format';
import { rpc, supabase } from '../../../lib/supabase';
import type { AuditFeedRow, Institution } from '../../../lib/types';

function csvCell(val: string): string {
  const safe = val.replace(/"/g, '""');
  return `"${safe}"`;
}

export function AuditTab({
  rows,
  institutions = [],
}: {
  rows: readonly AuditFeedRow[];
  institutions?: readonly Institution[];
}) {
  const [selectedInstitutionId, setSelectedInstitutionId] = useState<string>('');
  const [liveRows, setLiveRows] = useState<readonly AuditFeedRow[]>(rows);
  const [syncing, setSyncing] = useState(false);
  const [realtimeLive, setRealtimeLive] = useState(false);
  const seqRef = useRef(0);

  const fetchScopedAudit = useCallback(
    async (instId: string) => {
      const seq = ++seqRef.current;
      await Promise.resolve();
      if (seq !== seqRef.current) return;
      setSyncing(true);
      try {
        const data = await rpc<AuditFeedRow[]>('admin_audit_feed_by_institution', {
          p_institution_id: instId || null,
          p_limit: 200,
        });
        if (seq === seqRef.current) {
          setLiveRows(data);
        }
      } catch {
        if (seq === seqRef.current) {
          setLiveRows(
            instId ? rows.filter((r) => r.institution_id === instId) : rows,
          );
        }
      } finally {
        if (seq === seqRef.current) {
          setSyncing(false);
        }
      }
    },
    [rows],
  );

  useEffect(() => {
    const initialTimer = setTimeout(() => {
      void fetchScopedAudit(selectedInstitutionId);
    }, 0);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void fetchScopedAudit(selectedInstitutionId);
      }, 250);
    };

    const channelName = `admin-audit-${selectedInstitutionId || 'all'}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'audit_log',
          ...(selectedInstitutionId
            ? { filter: `institution_id=eq.${selectedInstitutionId}` }
            : {}),
        },
        scheduleRefresh,
      )
      .subscribe((status) => {
        setRealtimeLive(status === 'SUBSCRIBED');
      });

    const pollTimer = setInterval(() => {
      void fetchScopedAudit(selectedInstitutionId);
    }, 15_000);

    return () => {
      clearTimeout(initialTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      void supabase.removeChannel(channel);
    };
  }, [fetchScopedAudit, selectedInstitutionId]);

  const selectedInstitution = institutions.find((i) => i.id === selectedInstitutionId);

  function exportCsv() {
    const header = [
      'When (IST)',
      'Institution',
      'Action',
      'Object Type',
      'Object ID',
      'Actor',
      'Detail',
    ];
    const lines = liveRows.map((r) => [
      csvCell(formatDateTimeIst(r.at)),
      csvCell(r.institution_name ?? selectedInstitution?.name ?? 'Platform'),
      csvCell(r.action),
      csvCell(r.object_type),
      csvCell(r.object_id ?? ''),
      csvCell(`${r.actor_name} (${r.actor_role ?? 'system'})`),
      csvCell(JSON.stringify(r.detail)),
    ]);
    const csv = [header.map(csvCell).join(','), ...lines.map((l) => l.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xeio-audit-${selectedInstitution ? selectedInstitution.email_domain : 'all'}-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <label
            htmlFor="audit-university-filter"
            style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-2)' }}
          >
            University
          </label>
          <select
            id="audit-university-filter"
            aria-label="Filter audit log by university"
            value={selectedInstitutionId}
            onChange={(e) => setSelectedInstitutionId(e.target.value)}
            style={{ minWidth: 240 }}
          >
            <option value="">All onboarded universities</option>
            {institutions.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.name} ({inst.email_domain})
              </option>
            ))}
          </select>
          <Chip tone={realtimeLive ? 'good' : 'neutral'}>
            {syncing ? 'Syncing…' : realtimeLive ? 'Live · Synced' : 'Auto-sync (15s)'}
          </Chip>
        </div>

        <button type="button" className="btn" onClick={exportCsv} disabled={liveRows.length === 0}>
          Export CSV
        </button>
      </div>

      {liveRows.length === 0 ? (
        <Empty
          title={
            selectedInstitution
              ? `No audit events for ${selectedInstitution.name} yet`
              : 'No audit events yet'
          }
          body="Actions across the selected university appear here in real time."
        />
      ) : (
        <Card flush>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>When</th>
                  {!selectedInstitutionId ? <th>University</th> : null}
                  <th>Action</th>
                  <th>Object</th>
                  <th>Actor</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {liveRows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {formatDateTimeIst(a.at)}
                    </td>
                    {!selectedInstitutionId ? (
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {a.institution_name ?? 'Platform'}
                      </td>
                    ) : null}
                    <td className="mono" style={{ fontSize: 12 }}>
                      {a.action}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {a.object_type}
                      {a.object_id ? ` · ${a.object_id.slice(0, 8)}` : ''}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {a.actor_name} · <span className="mono">{a.actor_role ?? 'system'}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {JSON.stringify(a.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
