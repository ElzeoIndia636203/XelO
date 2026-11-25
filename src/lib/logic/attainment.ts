export type AttainmentLevel = 0 | 1 | 2 | 3;

export function level(pct: number, l1 = 60, l2 = 70, l3 = 80): AttainmentLevel {
  if (pct >= l3) return 3;
  if (pct >= l2) return 2;
  if (pct >= l1) return 1;
  return 0;
}

export interface CoAttainmentResult {
  attainedCount: number;
  totalCount: number;
  pct: number;
  level: AttainmentLevel;
}

export function coAttainment(
  scoresPct: readonly number[],
  thresholdPct = 60,
  l1 = 60,
  l2 = 70,
  l3 = 80,
): CoAttainmentResult {
  if (scoresPct.length === 0) {
    return { attainedCount: 0, totalCount: 0, pct: 0, level: 0 };
  }
  const attainedCount = scoresPct.filter((s) => s >= thresholdPct).length;
  const pct = Math.round((attainedCount * 100) / scoresPct.length);
  return {
    attainedCount,
    totalCount: scoresPct.length,
    pct,
    level: level(pct, l1, l2, l3),
  };
}

export function overall(
  internalPct: number,
  endsemPct: number,
  internalWeight = 0.4,
  endsemWeight = 0.6,
): number {
  return Math.round((internalPct * internalWeight + endsemPct * endsemWeight) * 10) / 10;
}

export interface CoLevelInput {
  coId: string;
  level: AttainmentLevel;
}

export interface CoPoMappingInput {
  co_id: string;
  po_code: string;
  level: number;
}

export interface PoAttainmentRow {
  poCode: string;
  attainment: number;
  mappedCos: number;
}

export function poAttainment(
  coLevels: readonly CoLevelInput[],
  mapRows: readonly CoPoMappingInput[],
): PoAttainmentRow[] {
  const coMap = new Map(coLevels.map((c) => [c.coId, c.level]));
  const acc = new Map<string, { weightedSum: number; weightTotal: number; mappedCos: number }>();

  for (const row of mapRows) {
    if (row.level <= 0) continue;
    const achievedLevel = coMap.get(row.co_id);
    if (achievedLevel === undefined) continue;
    const prev = acc.get(row.po_code) ?? { weightedSum: 0, weightTotal: 0, mappedCos: 0 };
    prev.weightedSum += achievedLevel * row.level;
    prev.weightTotal += row.level;
    prev.mappedCos += 1;
    acc.set(row.po_code, prev);
  }

  return Array.from(acc.entries())
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([poCode, v]) => ({
      poCode,
      attainment: v.weightTotal > 0 ? Math.round((v.weightedSum / v.weightTotal) * 100) / 100 : 0,
      mappedCos: v.mappedCos,
    }));
}
