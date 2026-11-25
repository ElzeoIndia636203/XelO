import { useState } from 'react';
import { Card, Chip, Empty, Kpis } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst } from '../../../lib/format';
import { computeCreditStatus, creditTone, usagePct } from '../../../lib/logic/credits';
import { rpc } from '../../../lib/supabase';
import type { AiUsageReportRow, PlanTier } from '../../../lib/types';

export function CreditsTab({
  rows,
  onNotify,
  onRefresh,
}: {
  rows: readonly AiUsageReportRow[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const enriched = rows.map((r) => {
    const status = computeCreditStatus({
      totalUsed: r.total_used,
      totalCap: r.total_cap,
      todayUsed: r.today_used,
      dailyCap: r.daily_cap,
      planActive: r.plan_active,
    });
    return { ...r, status };
  });

  const withPlan = enriched.filter((r) => r.tier !== null).length;
  const usedAll = enriched.reduce((sum, r) => sum + r.total_used, 0);
  const todayAll = enriched.reduce((sum, r) => sum + r.today_used, 0);
  const atCap = enriched.filter(
    (r) => r.status === 'Daily cap reached' || r.status === 'Subscription runs used up',
  ).length;

  async function switchPlan(row: AiUsageReportRow) {
    const next: PlanTier = row.tier === 'elite' ? 'pro' : 'elite';
    setBusy(true);
    try {
      await rpc('admin_set_faculty_plan', {
        p_user_id: row.user_id,
        p_plan: next,
      });
      onNotify(
        `${row.full_name} moved to ${next === 'elite' ? 'Elite' : 'Pro'}. New caps apply immediately.`,
        true,
      );
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Kpis
        items={[
          { label: 'Faculty with AI plans', value: withPlan },
          { label: 'Runs used this term', value: usedAll },
          { label: 'Runs today', value: todayAll },
          { label: 'At a cap today', value: atCap },
        ]}
      />

      {enriched.length === 0 ? (
        <Empty
          title="No active faculty accounts"
          body="Faculty and HOD AI credit usage will appear here once accounts sign in."
        />
      ) : (
        <Card flush>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Faculty</th>
                  <th>Plan</th>
                  <th>Valid until</th>
                  <th>Used this subscription</th>
                  <th style={{ textAlign: 'right' }}>Today</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map((cr) => {
                  const left = Math.max(0, cr.total_cap - cr.total_used);
                  const pct = usagePct(cr.total_used, cr.total_cap);
                  const barColor =
                    cr.total_cap > 0 && left <= 0
                      ? 'var(--danger)'
                      : cr.total_cap > 0 && left < cr.total_cap * 0.15
                        ? 'var(--assist)'
                        : 'var(--teal)';
                  return (
                    <tr key={cr.user_id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{cr.full_name}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {cr.email}
                        </div>
                      </td>
                      <td>{cr.tier === 'elite' ? 'Elite' : cr.tier === 'pro' ? 'Pro' : 'None'}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {cr.plan_end ? formatDateIst(cr.plan_end) : '—'}
                      </td>
                      <td style={{ minWidth: 190 }}>
                        <div className="mono" style={{ fontSize: 12 }}>
                          {cr.total_cap > 0
                            ? `${Math.min(cr.total_used, cr.total_cap)} of ${cr.total_cap} used · ${left} left`
                            : 'No active cap'}
                        </div>
                        <div
                          role="img"
                          aria-label={`${cr.full_name} usage: ${pct}%`}
                          style={{
                            height: 5,
                            background: 'var(--border-soft)',
                            borderRadius: 3,
                            marginTop: 4,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${pct}%`,
                              background: barColor,
                              borderRadius: 3,
                            }}
                          />
                        </div>
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {cr.daily_cap > 0 ? `${Math.min(cr.today_used, cr.daily_cap)}/${cr.daily_cap}` : '—'}
                      </td>
                      <td>
                        <Chip tone={creditTone(cr.status)}>{cr.status}</Chip>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn field-sm"
                          disabled={busy}
                          onClick={() => void switchPlan(cr)}
                        >
                          {cr.tier === 'elite' ? 'Move to Pro' : 'Move to Elite'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
