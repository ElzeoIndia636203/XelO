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
