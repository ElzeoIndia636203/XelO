export type ProctorEventKind =
  | 'tab_switch'
  | 'fullscreen_exit'
  | 'no_face'
  | 'multi_face'
  | 'copy_paste'
  | 'devtools'
  | 'disconnect'
  | 'camera_off';

export const PROCTOR_WARNING_THRESHOLD = 3;
export const MAX_DISCONNECT_PAUSE_SEC = 5 * 60;
export const NO_FACE_TRIGGER_MS = 10_000;
export const FACE_CHECK_INTERVAL_MS = 2_000;
export const AUTOSAVE_INTERVAL_MS = 10_000;

export interface ProctorPolicyState {
  warnings: number;
  flagged: boolean;
  terminated: boolean;
}

export function applyProctorWarning(currentWarnings: number): ProctorPolicyState {
  const warnings = Math.max(0, currentWarnings) + 1;
  return {
    warnings,
    flagged: warnings >= PROCTOR_WARNING_THRESHOLD,
    terminated: false, // 3 warnings flag for review; never auto-terminate
  };
}

export function remainingDisconnectPauseSeconds(usedSeconds: number, elapsedDisconnectSeconds: number): {
  allowedPause: number;
  totalUsed: number;
  exceeded: boolean;
} {
  const safeUsed = Math.max(0, usedSeconds);
  const safeElapsed = Math.max(0, elapsedDisconnectSeconds);
  const budgetLeft = Math.max(0, MAX_DISCONNECT_PAUSE_SEC - safeUsed);
  const allowedPause = Math.min(budgetLeft, safeElapsed);
  return {
    allowedPause,
    totalUsed: safeUsed + allowedPause,
    exceeded: safeElapsed > budgetLeft,
  };
}

export function formatExamCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}
