export type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;

const BLOOM_LEVELS: ReadonlyArray<{ level: BloomLevel; label: string; verbs: readonly string[] }> = [
  {
    level: 6,
    label: 'Create',
    verbs: ['create', 'design', 'formulate', 'architect', 'invent', 'synthesize', 'compose', 'devise', 'construct', 'optimize', 'integrate'],
  },
  {
    level: 5,
    label: 'Evaluate',
    verbs: ['evaluate', 'assess', 'justify', 'critique', 'verify', 'validate', 'judge', 'benchmark', 'defend', 'review', 'select'],
  },
  {
    level: 4,
    label: 'Analyze',
    verbs: ['analyze', 'analyse', 'differentiate', 'examine', 'debug', 'test', 'trace', 'contrast', 'inspect', 'categorize', 'distinguish'],
  },
  {
    level: 3,
    label: 'Apply',
    verbs: ['apply', 'implement', 'write', 'solve', 'use', 'execute', 'demonstrate', 'develop', 'code', 'build', 'compute', 'practice'],
  },
  {
    level: 2,
    label: 'Understand',
    verbs: ['understand', 'explain', 'describe', 'summarize', 'classify', 'interpret', 'discuss', 'illustrate', 'compare', 'paraphrase'],
  },
  {
    level: 1,
    label: 'Remember',
    verbs: ['define', 'list', 'recall', 'state', 'identify', 'name', 'recognize', 'memorize', 'repeat'],
  },
];

export function inferBloomLevel(statement: string): { btl: BloomLevel; label: string; verb: string | null } {
  const words = statement
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  for (const entry of BLOOM_LEVELS) {
    const matched = entry.verbs.find((v) => words.includes(v));
    if (matched) {
      return { btl: entry.level, label: entry.label, verb: matched };
    }
  }
  return { btl: 3, label: 'Apply', verb: null };
}

const PO_KEYWORDS: Record<string, readonly string[]> = {
  PO1: ['knowledge', 'fundamental', 'math', 'algorithm', 'principle', 'concept', 'understand', 'theory', 'data'],
  PO2: ['analyze', 'analyse', 'problem', 'complexity', 'debug', 'trace', 'identify', 'formulate'],
  PO3: ['design', 'develop', 'implement', 'build', 'solution', 'system', 'program', 'software', 'architecture'],
  PO4: ['investigate', 'experiment', 'test', 'verify', 'validate', 'research', 'data', 'evaluate'],
  PO5: ['tool', 'ide', 'compiler', 'git', 'python', 'java', 'rust', 'go', 'c++', 'modern', 'library', 'framework'],
  PO6: ['society', 'safety', 'health', 'legal', 'cultural', 'public', 'environment', 'sustainability', 'world', 'green'],
  PO7: ['ethic', 'plagiarism', 'integrity', 'privacy', 'security'],
  PO8: ['team', 'collaborat', 'group', 'individual'],
  PO9: ['communicat', 'report', 'document', 'present', 'viva'],
  PO10: ['project', 'manage', 'schedule', 'cost', 'plan', 'finance'],
  PO11: ['learn', 'lifelong', 'life-long', 'adapt', 'self'],
};

export function inferCoPoLevels(
  coStatement: string,
  btl: number,
  poDefs: ReadonlyArray<{ code: string; statement: string }>,
): Array<{ po_code: string; level: number }> {
  const tokens = coStatement
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((w) => w.length >= 3);

  return poDefs.map((po) => {
    const codeUpper = po.code.toUpperCase();
    const stmtTokens = po.statement
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((w) => w.length >= 4);
    const kws = PO_KEYWORDS[codeUpper] ?? [];

    let hits = 0;
    for (const t of tokens) {
      if (stmtTokens.some((s) => s.includes(t) || t.includes(s))) hits += 1;
      if (kws.some((k) => t.includes(k))) hits += 1;
    }

    // PSOs and core technical POs (PO1-PO5) align strongly with lab outcomes by BTL
    if (codeUpper.startsWith('PSO')) {
      const lvl = hits > 0 ? 3 : btl >= 3 ? 2 : 1;
      return { po_code: po.code, level: lvl };
    }
    if (hits >= 2) return { po_code: po.code, level: 3 };
    if (hits === 1) return { po_code: po.code, level: 2 };
    if (codeUpper === 'PO1' && btl <= 3) return { po_code: po.code, level: 2 };
    if (codeUpper === 'PO2' && btl >= 3) return { po_code: po.code, level: 2 };
    if (codeUpper === 'PO3' && btl >= 3) return { po_code: po.code, level: 2 };
    if (codeUpper === 'PO5' && btl >= 3) return { po_code: po.code, level: 1 };
    return { po_code: po.code, level: 0 };
  });
}
