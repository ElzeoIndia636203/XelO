export type CreditStatus =
  | 'OK'
  | 'Running low'
  | 'Daily cap reached'
  | 'Subscription runs used up'
  | 'No active plan';

export interface CreditUsageInput {
  totalUsed: number;
  totalCap: number;
  todayUsed: number;
  dailyCap: number;
  planActive: boolean;
}

export function computeCreditStatus(input: CreditUsageInput): CreditStatus {
  if (!input.planActive || input.totalCap <= 0) {
    return 'No active plan';
  }
  const remainingTotal = Math.max(0, input.totalCap - input.totalUsed);
  if (remainingTotal <= 0) {
    return 'Subscription runs used up';
  }
  if (input.todayUsed >= input.dailyCap) {
    return 'Daily cap reached';
  }
  if (remainingTotal < input.totalCap * 0.15) {
    return 'Running low';
  }
  return 'OK';
}

export function usagePct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * used) / cap)));
}

export function creditTone(status: CreditStatus): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'OK') return 'good';
  if (status === 'Running low') return 'warn';
  if (status === 'No active plan') return 'neutral';
  return 'bad';
}
