export type FacultyStepId =
  | 'setup'
  | 'batches'
  | 'plan'
  | 'questions'
  | 'banks'
  | 'sessions'
  | 'classroom'
  | 'assessments'
  | 'reports';

export interface AskResult {
  step?: FacultyStepId;
  inspectRoll?: string;
  sessionNumber?: number;
  reportTab?: 'file' | 'internal' | 'student';
  reply: string;
}

const ROUTES: Array<{ keys: readonly string[]; step: FacultyStepId; reply: string; reportTab?: 'file' | 'internal' | 'student' }> = [
  { keys: ['end-sem', 'endsem', 'assessment', 'exam'], step: 'assessments', reply: 'Opened assessments.' },
  { keys: ['today', 'attendance', 'monitor', 'live'], step: 'sessions', reply: 'Opened sessions monitor.' },
  { keys: ['quiz', 'task', 'announce', 'resource', 'class', 'timeline'], step: 'classroom', reply: 'Opened classroom timeline.' },
  { keys: ['course file'], step: 'reports', reportTab: 'file', reply: 'Opened course file report.' },
  { keys: ['slow', 'fast', 'internal', 'attain', 'bell', 'gap'], step: 'reports', reportTab: 'internal', reply: 'Opened internal attainment report.' },
  { keys: ['lab file', 'lab report'], step: 'reports', reportTab: 'student', reply: 'Opened student lab files.' },
  { keys: ['report', 'download', 'mark'], step: 'reports', reply: 'Opened reports.' },
  { keys: ['pre', 'post', 'bank'], step: 'banks', reply: 'Opened pre/post-test banks.' },
  { keys: ['question'], step: 'questions', reply: 'Opened lab questions.' },
  { keys: ['plan', 'calendar', 'schedule'], step: 'plan', reply: 'Opened session plan.' },
  { keys: ['batch', 'roster', 'student', 'code'], step: 'batches', reply: 'Opened batches and roster.' },
  { keys: ['setup', 'rubric', 'course', 'hod', 'outcome', 'syllabus'], step: 'setup', reply: 'Opened course setup.' },
];

export function parseAskCommand(raw: string): AskResult {
  const clean = raw.trim().toLowerCase();
  if (!clean) {
    return { reply: 'Try "open S13", "show 2301044", "batches", or "session plan".' };
  }

  const rollMatch = clean.match(/\b\d{6,10}\b/);
  if (rollMatch) {
    return {
      step: 'sessions',
      inspectRoll: rollMatch[0],
      reply: `Showing ${rollMatch[0]} in sessions.`,
    };
  }

  const sessMatch = clean.match(/\bs(\d{1,2})\b/i);
  if (sessMatch) {
    const n = Number(sessMatch[1]);
    if (n >= 1 && n <= 60) {
      return {
        step: 'sessions',
        sessionNumber: n,
        reply: `Opened S${n}.`,
      };
    }
  }

  for (const rule of ROUTES) {
    if (rule.keys.some((k) => clean.includes(k))) {
      return {
        step: rule.step,
        reportTab: rule.reportTab,
        reply: rule.reply,
      };
    }
  }

  return { reply: 'Try "open S13", "show 2301044", "batches", or "session plan".' };
}
