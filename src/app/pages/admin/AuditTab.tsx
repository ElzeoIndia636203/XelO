import { Card, Empty } from '../../../components/ui';
import { formatDateTimeIst, todayIso } from '../../../lib/format';
import type { AuditFeedRow } from '../../../lib/types';

function csvCell(val: string): string {
  const safe = val.replace(/"/g, '""');
  return `"${safe}"`;
}

export function AuditTab({ rows }: { rows: readonly AuditFeedRow[] }) {
  function exportCsv() {
    const header = ['When (IST)', 'Action', 'Object Type', 'Object ID', 'Actor', 'Detail'];
    const lines = rows.map((r) => [
      csvCell(formatDateTimeIst(r.at)),
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
    a.download = `xeio-audit-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <Empty title="No audit events yet" body="Actions across the platform are logged automatically." />
      ) : (
        <Card flush>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Object</th>
                  <th>Actor</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {formatDateTimeIst(a.at)}
                    </td>
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
