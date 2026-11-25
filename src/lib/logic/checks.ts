export interface RubricWeights {
  att: number;
  pre: number;
  post: number;
  vis: number;
  hid: number;
  viva: number;
}

export interface PlanCheckItem {
  ok: boolean;
  text: string;
}

export function rubricSum(r: RubricWeights): number {
  return r.att + r.pre + r.post + r.vis + r.hid + r.viva;
}

export function planChecks(
  rubric: RubricWeights,
  cos: ReadonlyArray<{ id?: string; code: string; btl: number }>,
  mappedCoRefs: readonly string[],
): PlanCheckItem[] {
  const checks: PlanCheckItem[] = [];
  const total = rubricSum(rubric);
  checks.push({
    ok: total === 50,
    text: total === 50 ? 'Rubric totals 50 marks (scaled to 100)' : `Rubric totals ${total} marks (must be 50)`,
  });

  if (cos.length === 0) {
    checks.push({ ok: false, text: 'No course outcomes added yet' });
  } else {
    const mappedSet = new Set(mappedCoRefs);
    const unmapped = cos.filter((c) => !mappedSet.has(c.code) && (!c.id || !mappedSet.has(c.id)));
    checks.push({
      ok: unmapped.length === 0,
      text:
        unmapped.length === 0
          ? `All ${cos.length} COs mapped to at least one PO`
          : `${unmapped.map((c) => c.code).join(', ')} missing a PO mapping`,
    });

    const btls = cos.map((c) => c.btl);
    const minBtl = Math.min(...btls);
    const maxBtl = Math.max(...btls);
    const spreadOk = cos.length === 1 || maxBtl > minBtl;
    checks.push({
      ok: spreadOk,
      text: spreadOk
        ? `Bloom levels span L${minBtl} to L${maxBtl}`
        : `All COs are at L${minBtl}; vary Bloom levels across units`,
    });
  }

  return checks;
}
