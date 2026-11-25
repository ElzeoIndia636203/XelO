import type { FacultyStepId } from './ask';

export interface NextBestAction {
  id: string;
  title: string;
  why: string;
  cta: string;
  step: FacultyStepId;
}

export function computeNextBestActions(input: {
  planStatus: 'draft' | 'sent' | 'approved' | 'declined';
  coCount: number;
  rubricTotal: number;
  batchesCount: number;
  sessionsCount: number;
  pickedSessionsCount?: number;
  banksReadySessionsCount?: number;
  activeSessionsCount: number;
}): NextBestAction[] {
  const actions: NextBestAction[] = [];

  if (input.planStatus === 'draft' || input.planStatus === 'declined') {
    if (input.coCount === 0) {
      actions.push({
        id: 'add-cos',
        title: 'Add or draft course outcomes',
        why: 'Course setup needs at least one CO before sending to the HOD.',
        cta: 'Open setup',
        step: 'setup',
      });
    } else if (input.rubricTotal !== 50) {
      actions.push({
        id: 'fix-rubric',
        title: 'Adjust marking rubric to 50',
        why: `Currently ${input.rubricTotal}/50 raw marks.`,
        cta: 'Fix rubric',
        step: 'setup',
      });
    } else {
      actions.push({
        id: 'send-hod',
        title:
          input.planStatus === 'declined'
            ? 'Update and resend course plan'
            : 'Send course plan to HOD',
        why: `${input.coCount} COs and 50-mark rubric are ready for approval.`,
        cta: 'Review setup',
        step: 'setup',
      });
    }
  } else if (input.planStatus === 'sent') {
    actions.push({
      id: 'wait-hod',
      title: 'Waiting for HOD approval',
      why: 'Course plan is locked while under department HOD review.',
      cta: 'View setup',
      step: 'setup',
    });
  }

  if (input.batchesCount === 0) {
    actions.push({
      id: 'import-roster',
      title: 'Import section roster',
      why: 'Split students into batches of at most 65 and generate class codes.',
      cta: 'Open batches',
      step: 'batches',
    });
  }

  if (input.sessionsCount === 0) {
    actions.push({
      id: 'save-plan',
      title: 'Build session plan from calendar',
      why: 'Schedule lab dates, pre-test windows, and post-test windows.',
      cta: 'Plan sessions',
      step: 'plan',
    });
  } else if (input.planStatus === 'approved' && input.activeSessionsCount < input.sessionsCount) {
    if (
      typeof input.pickedSessionsCount === 'number' &&
      input.pickedSessionsCount < input.sessionsCount
    ) {
      const remQ = input.sessionsCount - input.pickedSessionsCount;
      actions.push({
        id: 'prepare-questions',
        title: `Pick lab questions (${remQ} left)`,
        why: 'Every session needs 2 validated lab questions before activation.',
        cta: 'Open questions',
        step: 'questions',
      });
    }
    if (
      typeof input.banksReadySessionsCount === 'number' &&
      input.banksReadySessionsCount < input.sessionsCount
    ) {
      const remB = input.sessionsCount - input.banksReadySessionsCount;
      actions.push({
        id: 'prepare-banks',
        title: `Approve pre/post banks (${remB} left)`,
        why: 'Approve 45 pre and 45 post MCQs with no overlap to activate sessions.',
        cta: 'Open banks',
        step: 'banks',
      });
    }
    if (
      typeof input.pickedSessionsCount !== 'number' &&
      typeof input.banksReadySessionsCount !== 'number'
    ) {
      const remaining = input.sessionsCount - input.activeSessionsCount;
      actions.push({
        id: 'prepare-questions',
        title: `Prepare ${remaining} pending sessions`,
        why: 'Approve 2 lab questions and both test banks to activate each session.',
        cta: 'Open questions',
        step: 'questions',
      });
    }
  }

  return actions.slice(0, 5);
}
