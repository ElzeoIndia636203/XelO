export type ProctorEventKind =
  | 'tab_switch'
  | 'fullscreen_exit'
  | 'no_face'
  | 'multi_face'
  | 'copy_paste'
  | 'devtools'
  | 'disconnect'
  | 'camera_off';

export type ProctorLevel = 1 | 2 | 3;
export type ProctorSeverity = 'S0' | 'S1' | 'S2' | 'S3';

export type ProctorRuleId =
  | 'PC-01' | 'PC-02' | 'PC-03' | 'PC-04' | 'PC-05' | 'PC-06' | 'PC-07'
  | 'PC-08' | 'PC-09' | 'PC-10' | 'PC-11' | 'PC-12' | 'PC-13'
  | 'BL-01' | 'BL-02' | 'BL-03' | 'BL-04' | 'BL-05' | 'BL-06' | 'BL-07'
  | 'BL-08' | 'BL-09' | 'BL-10' | 'BL-11' | 'BL-12' | 'BL-13' | 'BL-14'
  | 'AI-01' | 'AI-02' | 'AI-03' | 'AI-04' | 'AI-05' | 'AI-06' | 'AI-07'
  | 'AI-08' | 'AI-09' | 'AI-10' | 'AI-11'
  | 'AU-01' | 'AU-02' | 'AU-03'
  | 'SC-01' | 'SC-02' | 'SC-03'
  | 'CB-01' | 'CB-02' | 'CB-03' | 'CB-04' | 'CB-05'
  | 'RS-01' | 'RS-02' | 'RS-03' | 'RS-04' | 'RS-05' | 'RS-06' | 'RS-07';

export interface ProctorMediaConfig {
  camera: boolean;
  microphone: boolean;
  screenShare: boolean;
}

export interface ProctorConfig {
  version: number;
  level: ProctorLevel;
  media: ProctorMediaConfig;
  levelReason: string | null;
  ladder: { toast: number; modal: number; flag: number; visit: number };
  score: { start: number; clean: number; reviewRequired: number; dedupeSeconds: number };
  sampling: {
    faceMs: number;
    landmarksMs: number;
    objectsMs: number;
    identityMs: number;
    screenFrameMs: number;
    heartbeatMs: number;
    autosaveMs: number;
  };
  roomScanEnabled?: boolean;
}

export interface StudentAccommodation {
  extra_time_minutes: number;
  relax_screen_reader: boolean;
  scribe_reader: boolean;
  allow_medical_breaks: boolean;
  no_camera: boolean;
}

export const PROCTOR_WARNING_THRESHOLD = 3;
export const MAX_DISCONNECT_PAUSE_SEC = 5 * 60;
export const NO_FACE_TRIGGER_MS = 10_000;
export const FACE_CHECK_INTERVAL_MS = 2_000;
export const AUTOSAVE_INTERVAL_MS = 10_000;

export function normalizeProctorMedia(
  level: ProctorLevel,
  requested?: Partial<ProctorMediaConfig>,
): ProctorMediaConfig {
  if (level === 3) {
    return { camera: true, microphone: true, screenShare: true };
  }
  if (level === 2) {
    return {
      camera: Boolean(requested?.camera ?? false),
      microphone: Boolean(requested?.microphone ?? false),
      screenShare: true,
    };
  }
  return { camera: false, microphone: false, screenShare: false };
}

export function defaultProctorConfig(
  level: ProctorLevel = 2,
  requestedMedia?: Partial<ProctorMediaConfig>,
  levelReason: string | null = null,
): ProctorConfig {
  return {
    version: 1,
    level,
    media: normalizeProctorMedia(level, requestedMedia),
    levelReason,
    ladder: { toast: 1, modal: 2, flag: 3, visit: 5 },
    score: { start: 100, clean: 85, reviewRequired: 60, dedupeSeconds: 60 },
    sampling: {
      faceMs: 1000,
      landmarksMs: 1000,
      objectsMs: 3000,
      identityMs: 60000,
      screenFrameMs: 10000,
      heartbeatMs: 15000,
      autosaveMs: 10000,
    },
    roomScanEnabled: false,
  };
}

export function resolveEffectiveRules(
  config: ProctorConfig,
  accommodation?: Partial<StudentAccommodation>,
): {
  cameraRequired: boolean;
  micRequired: boolean;
  screenShareRequired: boolean;
  talkingCheckEnabled: boolean;
  singleMonitorRequired: boolean;
  vmBlockingEnabled: boolean;
  enabledRules: Set<ProctorRuleId>;
} {
  const media = normalizeProctorMedia(config.level, config.media);
  const cameraRequired = media.camera && !accommodation?.no_camera;
  const micRequired = media.microphone;
  const screenShareRequired = media.screenShare;
  const talkingCheckEnabled = cameraRequired && micRequired;

  const enabled = new Set<ProctorRuleId>([
    'PC-01', 'PC-02', 'PC-03', 'PC-07', 'PC-08', 'PC-09', 'PC-10', 'PC-11', 'PC-12',
    'BL-01', 'BL-02', 'BL-03', 'BL-04', 'BL-05', 'BL-06', 'BL-07', 'BL-08', 'BL-09', 'BL-10', 'BL-11', 'BL-13', 'BL-14',
    'CB-01', 'CB-02', 'CB-03', 'CB-04', 'CB-05',
    'RS-01', 'RS-02', 'RS-03', 'RS-04', 'RS-05', 'RS-06', 'RS-07',
  ]);

  if (cameraRequired) {
    enabled.add('PC-04');
    if (config.roomScanEnabled) enabled.add('PC-13');
    for (const r of ['AI-01', 'AI-02', 'AI-03', 'AI-04', 'AI-05', 'AI-06', 'AI-07', 'AI-08', 'AI-09', 'AI-10'] as const) {
      enabled.add(r);
    }
  }
  if (micRequired) {
    enabled.add('PC-05');
    enabled.add('AU-01');
    enabled.add('AU-02');
    enabled.add('AU-03');
  }
  if (talkingCheckEnabled) {
    enabled.add('AI-11');
  }
  if (screenShareRequired) {
    enabled.add('PC-06');
    enabled.add('BL-12');
    enabled.add('SC-01');
    enabled.add('SC-02');
    enabled.add('SC-03');
  }

  if (accommodation?.relax_screen_reader) {
    enabled.delete('BL-13');
    enabled.delete('SC-01');
  }
  if (accommodation?.scribe_reader) {
    enabled.delete('AI-02');
    enabled.delete('AI-09');
    enabled.delete('AU-01');
    enabled.delete('AU-02');
  }

  return {
    cameraRequired,
    micRequired,
    screenShareRequired,
    talkingCheckEnabled,
    singleMonitorRequired: true,
    vmBlockingEnabled: config.level >= 2,
    enabledRules: enabled,
  };
}

export function computeIntegrityBand(
  score: number,
  hasS2: boolean,
): 'clean' | 'review_suggested' | 'review_required' {
  if (hasS2 || score < 60) return 'review_required';
  if (score < 85) return 'review_suggested';
  return 'clean';
}

export function analyzeCodeInsert(charsAdded: number, copiedInternally: boolean): boolean {
  return !copiedInternally && charsAdded >= 80;
}

export function analyzeKeystrokeTimings(gapsMs: readonly number[]): boolean {
  if (gapsMs.length < 100) return false;
  const recent = gapsMs.slice(-100);
  const fastCount = recent.filter((g) => g > 0 && g < 15).length;
  return fastCount >= 90;
}

export function analyzeBurstShare(charsIn30s: number, totalChars: number, totalLines: number): boolean {
  if (totalLines < 20 || totalChars <= 0) return false;
  return charsIn30s / totalChars > 0.7;
}

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
    terminated: false,
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
