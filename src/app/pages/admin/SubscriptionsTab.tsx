import { useState, type FormEvent } from 'react';
import { Card, Chip, Empty } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, todayIso } from '../../../lib/format';
import { rpc } from '../../../lib/supabase';
import type {
  Institution,
  Plan,
  PlanTier,
  Profile,
  SubscriptionRequest,
} from '../../../lib/types';

function computeValidUntil(startDate: string, months: number): string {
  const d = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatDateIst(d);
}

export function SubscriptionsTab({
  institutions,
  profiles,
  plans,
  requests,
  onNotify,
  onRefresh,
}: {
  institutions: readonly Institution[];
  profiles: readonly Profile[];
  plans: readonly Plan[];
  requests: readonly SubscriptionRequest[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const proPlan = plans.find((p) => p.tier === 'pro') ?? { tier: 'pro' as const, total_cap: 125, daily_cap: 5 };
  const elitePlan = plans.find((p) => p.tier === 'elite') ?? { tier: 'elite' as const, total_cap: 250, daily_cap: 7 };

  const [capEdits, setCapEdits] = useState<
    Partial<Record<PlanTier, { total: number; daily: number }>>
  >({});
  const caps: Record<PlanTier, { total: number; daily: number }> = {
    pro: capEdits.pro ?? { total: proPlan.total_cap, daily: proPlan.daily_cap },
    elite: capEdits.elite ?? { total: elitePlan.total_cap, daily: elitePlan.daily_cap },
  };
  const [reqInstId, setReqInstId] = useState(institutions[0]?.id ?? '');
  const [reqPlan, setReqPlan] = useState<PlanTier>('pro');
  const [reqStart, setReqStart] = useState(todayIso());
  const [reqMonths, setReqMonths] = useState<3 | 6 | 12>(6);
  const [reqScope, setReqScope] = useState('');
  const [edits, setEdits] = useState<
    Record<string, { plan: PlanTier; start: string; months: 3 | 6 | 12 }>
  >({});
  const [busy, setBusy] = useState(false);

  const instMap = new Map(institutions.map((i) => [i.id, i]));
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  async function saveCaps(tier: PlanTier) {
    setBusy(true);
    try {
      await rpc('admin_update_plan_caps', {
        p_tier: tier,
        p_total_cap: caps[tier].total,
        p_daily_cap: caps[tier].daily,
      });
      setCapEdits((prev) => {
        const next = { ...prev };
        delete next[tier];
        return next;
      });
      onNotify(`Updated ${tier === 'elite' ? 'Elite' : 'Pro'} caps.`, true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function createRequest(e: FormEvent) {
    e.preventDefault();
    const targetInst = reqInstId || institutions[0]?.id;
    if (!targetInst) return;
    setBusy(true);
    try {
      await rpc('admin_create_subscription_request', {
        p_institution_id: targetInst,
        p_plan: reqPlan,
        p_start_date: reqStart,
        p_months: reqMonths,
        p_scope_label: reqScope.trim() || instMap.get(targetInst)?.name || '',
      });
      setReqScope('');
      onNotify('Subscription request recorded.', true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function decide(req: SubscriptionRequest, approve: boolean) {
    const patch = edits[req.id];
    const plan = patch?.plan ?? req.plan;
    const start = patch?.start ?? req.start_date;
    const months = patch?.months ?? req.months;

    setBusy(true);
    try {
      await rpc('decide_subscription', {
        p_request_id: req.id,
        p_approve: approve,
        p_plan: plan,
        p_start_date: start,
        p_months: months,
      });
      onNotify(
        approve
          ? `${plan === 'elite' ? 'Elite' : 'Pro'} approved for ${req.scope_label || 'institution'}, ${months} months from ${start}.`
          : 'Subscription request rejected.',
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
      <div className="grid-2">
        {(['pro', 'elite'] as const).map((tier) => {
          const instCount = institutions.filter((i) => i.plan === tier).length;
          const facCount = profiles.filter((p) => {
            if (!p.active || (p.role !== 'faculty' && p.role !== 'hod')) return false;
            const effective = p.plan_override ?? instMap.get(p.institution_id ?? '')?.plan ?? null;
            return effective === tier;
          }).length;
          return (
            <Card
              key={tier}
              title={tier === 'elite' ? 'Elite' : 'Pro'}
              actions={
                <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {instCount} institutions · {facCount} faculty active
                </span>
              }
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
                <label className="field-label">
                  AI runs per subscription
                  <input
                    className="field mono"
                    type="number"
                    min={0}
                    value={caps[tier].total}
                    onChange={(e) =>
                      setCapEdits((prev) => ({
                        ...prev,
                        [tier]: {
                          total: Math.max(0, Number(e.target.value) || 0),
                          daily: caps[tier].daily,
                        },
                      }))
                    }
                    style={{ width: 120 }}
                  />
                </label>
                <label className="field-label">
                  Daily cap
                  <input
                    className="field mono"
                    type="number"
                    min={1}
                    value={caps[tier].daily}
                    onChange={(e) =>
                      setCapEdits((prev) => ({
                        ...prev,
                        [tier]: {
                          total: caps[tier].total,
                          daily: Math.max(1, Number(e.target.value) || 1),
                        },
                      }))
                    }
                    style={{ width: 100 }}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void saveCaps(tier)}
                >
                  Save caps
                </button>
              </div>
              <p style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                One run = one AI drafting request (questions, banks, tasks, announcements). Approvals, uploads and
                monitoring never use runs.
              </p>
            </Card>
          );
        })}
      </div>

      <Card title="Record subscription request">
        <form
          onSubmit={createRequest}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
        >
          <label className="field-label">
            Institution
            <select
              className="field"
              value={reqInstId || institutions[0]?.id || ''}
              onChange={(e) => setReqInstId(e.target.value)}
              style={{ minWidth: 180 }}
            >
              {institutions.length === 0 ? <option value="">No institutions</option> : null}
              {institutions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Plan
            <select
              className="field"
              value={reqPlan}
              onChange={(e) => setReqPlan(e.target.value as PlanTier)}
            >
              <option value="pro">Pro</option>
              <option value="elite">Elite</option>
            </select>
          </label>
          <label className="field-label">
            Start
            <input
              className="field mono"
              type="date"
              value={reqStart}
              onChange={(e) => setReqStart(e.target.value)}
            />
          </label>
          <label className="field-label">
            Duration
            <select
              className="field"
              value={reqMonths}
              onChange={(e) => setReqMonths(Number(e.target.value) as 3 | 6 | 12)}
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </label>
          <label className="field-label">
            For (university)
            <input
              className="field"
              value={reqScope}
              onChange={(e) => setReqScope(e.target.value)}
              placeholder="University name (e.g. Sanjivani University)"
              style={{ width: 240 }}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || institutions.length === 0}>
            Record request
          </button>
        </form>
      </Card>

      {requests.length === 0 ? (
        <Empty title="No subscription requests" body="Record a manual subscription request above." />
      ) : (
        <Card title="Subscription requests · approved manually" flush>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Requested by</th>
                  <th>For</th>
                  <th>Plan</th>
                  <th>Start</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const locked = r.status !== 'sent';
                  const cur = edits[r.id] ?? { plan: r.plan, start: r.start_date, months: r.months };
                  const requester = profileMap.get(r.requested_by ?? '')?.email ?? 'superadmin';
                  const instName = instMap.get(r.institution_id)?.name ?? '';
                  return (
                    <tr key={r.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {requester}
                      </td>
                      <td style={{ fontSize: 12 }}>{r.scope_label || instName}</td>
                      <td>
                        <select
                          aria-label="Plan"
                          className="field field-sm"
                          disabled={locked || busy}
                          value={cur.plan}
                          onChange={(e) =>
                            setEdits((prev) => ({
                              ...prev,
                              [r.id]: { ...cur, plan: e.target.value as PlanTier },
                            }))
                          }
                        >
                          <option value="pro">Pro</option>
                          <option value="elite">Elite</option>
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label="Start date"
                          className="field field-sm mono"
                          type="date"
                          disabled={locked || busy}
                          value={cur.start}
                          onChange={(e) =>
                            setEdits((prev) => ({
                              ...prev,
                              [r.id]: { ...cur, start: e.target.value },
                            }))
                          }
                        />
                      </td>
                      <td>
                        <select
                          aria-label="Duration"
                          className="field field-sm"
                          disabled={locked || busy}
                          value={cur.months}
                          onChange={(e) =>
                            setEdits((prev) => ({
                              ...prev,
                              [r.id]: { ...cur, months: Number(e.target.value) as 3 | 6 | 12 },
                            }))
                          }
                        >
                          <option value={3}>3 months</option>
                          <option value={6}>6 months</option>
                          <option value={12}>12 months</option>
                        </select>
                      </td>
                      <td>
                        <Chip
                          tone={
                            r.status === 'approved' ? 'good' : r.status === 'sent' ? 'warn' : 'bad'
                          }
                        >
                          {r.status === 'approved'
                            ? 'Active'
                            : r.status === 'sent'
                              ? 'Pending approval'
                              : 'Rejected'}
                        </Chip>
                        {r.status !== 'rejected' ? (
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            until {computeValidUntil(cur.start, cur.months)}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {!locked ? (
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-teal field-sm"
                              disabled={busy}
                              onClick={() => void decide(r, true)}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="btn field-sm"
                              disabled={busy}
                              onClick={() => void decide(r, false)}
                            >
                              Reject
                            </button>
                          </div>
                        ) : null}
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
