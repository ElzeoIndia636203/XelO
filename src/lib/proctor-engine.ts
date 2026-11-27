import { useEffect, useRef } from 'react';
import {
  resolveEffectiveRules,
  type ProctorConfig,
  type ProctorRuleId,
  type ProctorSeverity,
  type StudentAccommodation,
} from './logic/proctor';
import {
  checkSingleMonitor,
  detectFacesInFrame,
  getProctorStreams,
  loadFaceDetector,
} from './proctor-runtime';
import { rpc } from './supabase';

export interface ProctorEngineCallbacks {
  onToast: (ruleId: ProctorRuleId, message: string) => void;
  onModal: (ruleId: ProctorRuleId, message: string) => void;
  onHold: (ruleId: ProctorRuleId | null, message: string) => void;
  onSecondTabBlocked: () => void;
  onServerUpdate: (state: {
    warningCount: number;
    integrityScore: number;
    flagged: boolean;
    activeHoldRule: string | null;
    autoSubmitted?: boolean;
  }) => void;
  onFaceCountChange: (faces: number) => void;
  onStatusChange: (status: {
    cameraOk: boolean;
    micOk: boolean;
    screenOk: boolean;
    fullscreenOk: boolean;
  }) => void;
}

interface QueuedEvent {
  ruleId: ProctorRuleId;
  level: ProctorSeverity;
  confidence?: number;
  durationSec?: number;
  questionId?: string;
  detail?: Record<string, unknown>;
}

const RULE_MESSAGES: Partial<Record<ProctorRuleId, string>> = {
  'BL-01': 'Stay in fullscreen mode during the assessment.',
  'BL-02': 'Stay on the assessment tab.',
  'BL-03': 'Keep focus on the assessment window.',
  'BL-04': 'Paste from outside the assessment is blocked.',
  'BL-05': 'Drag and drop is disabled during the assessment.',
  'BL-06': 'Right-click menu is disabled.',
  'BL-07': 'Shortcut is blocked during the assessment.',
  'BL-08': 'Close Developer Tools to continue.',
  'BL-09': 'Printing or saving the assessment page is blocked.',
  'BL-10': 'Your work is saved; reloading or leaving is logged.',
  'BL-11': 'This assessment is already open in another tab.',
  'BL-12': 'Share your entire screen to continue.',
  'BL-13': 'Keep the browser window maximized.',
  'BL-14': 'Disable injecting browser extensions.',
  'AI-01': 'Keep your face visible to the camera.',
  'AI-02': 'Only one person should be visible at the screen.',
  'AI-10': 'Camera appears covered or frozen.',
  'SC-02': 'Disconnect any secondary display.',
  'SC-03': 'Entire-screen share surface changed.',
};

export function useProctorEngine({
  enabled,
  assessmentType,
  attemptId,
  config,
  accommodation,
  activeQuestionId,
  callbacks,
}: {
  enabled: boolean;
  assessmentType: 'endsem' | 'instant';
  attemptId: string;
  config: ProctorConfig;
  accommodation?: Partial<StudentAccommodation>;
  activeQuestionId?: string;
  callbacks: ProctorEngineCallbacks;
}) {
  const cbRef = useRef(callbacks);
  const qIdRef = useRef(activeQuestionId);
  const queueRef = useRef<QueuedEvent[]>([]);
  const flushingRef = useRef(false);
  const hiddenSinceRef = useRef<number | null>(null);
  const blurSinceRef = useRef<number | null>(null);
  const tabSwitchCountRef = useRef(0);
  const pasteBlockCountRef = useRef(0);
  const noFaceSinceRef = useRef<number | null>(null);
  const multiFaceSinceRef = useRef<number | null>(null);

  useEffect(() => {
    cbRef.current = callbacks;
  });

  useEffect(() => {
    qIdRef.current = activeQuestionId;
  }, [activeQuestionId]);

  useEffect(() => {
    if (!enabled || !attemptId) return;

    const effective = resolveEffectiveRules(config, accommodation);
    let alive = true;
    let degraded = false;

    const flushQueue = async () => {
      if (flushingRef.current || queueRef.current.length === 0) return;
      flushingRef.current = true;
      try {
        while (queueRef.current.length > 0 && alive) {
          const ev = queueRef.current[0]!;
          const res = await rpc<{
            warning_count: number;
            integrity_score: number;
            flagged: boolean;
            active_hold_rule: string | null;
            auto_submitted?: boolean;
            ladder_action: 'none' | 'toast' | 'modal' | 'hold' | 'auto_submitted';
          }>('log_proctor_event_v2', {
            p_assessment_type: assessmentType,
            p_attempt_id: attemptId,
            p_rule_id: ev.ruleId,
            p_level: ev.level,
            p_confidence: ev.confidence ?? null,
            p_duration_sec: ev.durationSec ?? 0,
            p_question_id: ev.questionId ?? qIdRef.current ?? null,
            p_detail: { message: RULE_MESSAGES[ev.ruleId] ?? ev.ruleId, ...(ev.detail ?? {}) },
          });
          queueRef.current.shift();
          if (!alive) break;
          cbRef.current.onServerUpdate({
            warningCount: res.warning_count,
            integrityScore: res.integrity_score,
            flagged: res.flagged,
            activeHoldRule: res.active_hold_rule,
            autoSubmitted: Boolean(res.auto_submitted),
          });
          const msg = RULE_MESSAGES[ev.ruleId] ?? ev.ruleId;
          if (res.auto_submitted || res.ladder_action === 'auto_submitted') {
            cbRef.current.onHold(null, '');
            cbRef.current.onModal(ev.ruleId, `2nd proctor breach (${ev.ruleId}): your test was automatically submitted.`);
          } else if (res.ladder_action === 'hold') {
            cbRef.current.onHold(ev.ruleId, msg);
          } else if (res.ladder_action === 'modal') {
            cbRef.current.onModal(ev.ruleId, msg);
          } else if (res.ladder_action === 'toast') {
            cbRef.current.onToast(ev.ruleId, msg);
          }
        }
      } catch {
        // Keep events queued for RS-07 retry on next heartbeat/event
      } finally {
        flushingRef.current = false;
      }
    };

    const emit = (
      ruleId: ProctorRuleId,
      level: ProctorSeverity,
      extra?: Omit<QueuedEvent, 'ruleId' | 'level'>,
    ) => {
      if (!effective.enabledRules.has(ruleId)) return;
      queueRef.current.push({ ruleId, level, ...extra });
      void flushQueue();
    };

    const syncStatus = () => {
      const streams = getProctorStreams();
      const camTrack = streams.camStream?.getVideoTracks()[0];
      const micTrack = streams.camStream?.getAudioTracks()[0];
      const scrTrack = streams.screenStream?.getVideoTracks()[0];
      cbRef.current.onStatusChange({
        cameraOk: !effective.cameraRequired || Boolean(camTrack && camTrack.readyState === 'live' && camTrack.enabled),
        micOk: !effective.micRequired || Boolean(micTrack && micTrack.readyState === 'live' && micTrack.enabled),
        screenOk: !effective.screenShareRequired || Boolean(scrTrack && scrTrack.readyState === 'live' && scrTrack.enabled),
        fullscreenOk: Boolean(document.fullscreenElement),
      });
    };

    // BL-11: One exam window only via BroadcastChannel
    const channel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`xeio-proctor-${assessmentType}-${attemptId}`)
      : null;
    if (channel) {
      channel.onmessage = (e) => {
        if (e.data === 'ping') {
          channel.postMessage('pong');
        } else if (e.data === 'pong') {
          emit('BL-11', 'S2');
          cbRef.current.onSecondTabBlocked();
        }
      };
      channel.postMessage('ping');
    }

    // BL-01: Fullscreen exit
    const onFullscreen = () => {
      syncStatus();
      if (!document.fullscreenElement) {
        emit('BL-01', 'S3');
      }
    };

    // BL-02: Tab visibility
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
      } else if (hiddenSinceRef.current) {
        const sec = Math.round((Date.now() - hiddenSinceRef.current) / 1000);
        hiddenSinceRef.current = null;
        tabSwitchCountRef.current += 1;
        const lvl: ProctorSeverity = sec >= 5 || tabSwitchCountRef.current >= 3 ? 'S2' : 'S1';
        emit('BL-02', lvl, { durationSec: sec });
      }
    };

    // BL-03: Window blur
    const onBlur = () => {
      blurSinceRef.current = Date.now();
    };
    const onFocus = () => {
      if (blurSinceRef.current && !document.hidden) {
        const sec = Math.round((Date.now() - blurSinceRef.current) / 1000);
        blurSinceRef.current = null;
        emit('BL-03', sec > 10 ? 'S2' : 'S1', { durationSec: sec });
      } else {
        blurSinceRef.current = null;
      }
    };

    // BL-04: External paste / copy block (allow internal editor paste)
    let internalCopyToken = '';
    const onCopy = () => {
      const sel = window.getSelection()?.toString() ?? '';
      if (sel) internalCopyToken = sel;
    };
    const onPaste = (e: ClipboardEvent) => {
      const pasted = e.clipboardData?.getData('text') ?? '';
      if (pasted && pasted === internalCopyToken) return;
      e.preventDefault();
      pasteBlockCountRef.current += 1;
      emit('BL-04', pasteBlockCountRef.current >= 3 ? 'S2' : 'S1', {
        detail: { chars: pasted.length },
      });
    };

    // BL-05: Drag & drop
    const onDragDrop = (e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'drop') emit('BL-05', 'S1');
    };

    // BL-06: Context menu
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      emit('BL-06', 'S0');
    };

    // BL-07: Blocked shortcuts
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (
        e.key === 'F12' ||
        (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) ||
        (mod && ['p', 's', 'u'].includes(k))
      ) {
        e.preventDefault();
        emit('BL-07', 'S0', { detail: { key: e.key } });
      }
    };

    // BL-09: Print
    const onBeforePrint = (e: Event) => {
      e.preventDefault();
      emit('BL-09', 'S1');
    };

    // BL-10: Reload / back
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      emit('BL-10', 'S1');
    };

    // BL-13 & SC-02: Resize / extra monitor
    const onResize = () => {
      if (document.fullscreenElement) return;
      if (window.innerWidth < window.screen.availWidth * 0.9 || window.innerHeight < window.screen.availHeight * 0.9) {
        emit('BL-13', 'S1');
      }
      if (!checkSingleMonitor()) {
        emit('SC-02', 'S2');
      }
    };

    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragDrop);
    document.addEventListener('drop', onDragDrop);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('resize', onResize);

    // BL-12 / SC-03: Screen track ended
    const scrTrack = getProctorStreams().screenStream?.getVideoTracks()[0];
    const onScreenEnded = () => {
      syncStatus();
      emit('BL-12', 'S3');
    };
    scrTrack?.addEventListener('ended', onScreenEnded);

    // Periodic checks: BL-08 devtools size gap, RS-03 heartbeat, AI-01/02 face detection
    let videoEl: HTMLVideoElement | null = null;
    if (effective.cameraRequired && getProctorStreams().camStream) {
      videoEl = document.createElement('video');
      videoEl.srcObject = getProctorStreams().camStream;
      videoEl.muted = true;
      void videoEl.play().catch(() => {});
    }

    const devtoolsTimer = window.setInterval(() => {
      if (!document.fullscreenElement) return;
      const wGap = window.outerWidth - window.innerWidth;
      const hGap = window.outerHeight - window.innerHeight;
      if (wGap > 160 || hGap > 160) {
        emit('BL-08', 'S2', { detail: { wGap, hGap } });
      }
    }, 10_000);

    const heartbeatTimer = window.setInterval(() => {
      syncStatus();
      void flushQueue();
      void rpc('proctor_heartbeat', {
        p_assessment_type: assessmentType,
        p_attempt_id: attemptId,
        p_degraded: degraded,
      }).catch(() => {});
    }, config.sampling.heartbeatMs || 15_000);

    let aiTimer: number | null = null;
    if (effective.cameraRequired && videoEl) {
      let detectorPromise: ReturnType<typeof loadFaceDetector> | null = loadFaceDetector().catch(() => {
        degraded = true;
        emit('AI-01', 'S0', { detail: { degraded: true } });
        return null as never;
      });
      aiTimer = window.setInterval(async () => {
        if (!alive || !videoEl || videoEl.readyState < 2 || !detectorPromise) return;
        try {
          const det = await detectorPromise;
          if (!det) return;
          const faces = detectFacesInFrame(det, videoEl);
          cbRef.current.onFaceCountChange(faces);
          const now = Date.now();
          if (faces === 0) {
            multiFaceSinceRef.current = null;
            if (!noFaceSinceRef.current) noFaceSinceRef.current = now;
            const sec = Math.round((now - noFaceSinceRef.current) / 1000);
            if (sec >= 20) emit('AI-01', 'S2', { durationSec: sec, confidence: 0.6 });
            else if (sec >= 5) emit('AI-01', 'S1', { durationSec: sec, confidence: 0.6 });
          } else if (faces >= 2) {
            noFaceSinceRef.current = null;
            if (!multiFaceSinceRef.current) multiFaceSinceRef.current = now;
            const sec = Math.round((now - multiFaceSinceRef.current) / 1000);
            if (sec >= 3) emit('AI-02', 'S2', { durationSec: sec, confidence: 0.75 });
          } else {
            noFaceSinceRef.current = null;
            multiFaceSinceRef.current = null;
          }
        } catch {
          degraded = true;
          detectorPromise = null;
        }
      }, config.sampling.faceMs || 1000);
    }

    syncStatus();

    return () => {
      alive = false;
      channel?.close();
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragDrop);
      document.removeEventListener('drop', onDragDrop);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('resize', onResize);
      scrTrack?.removeEventListener('ended', onScreenEnded);
      window.clearInterval(devtoolsTimer);
      window.clearInterval(heartbeatTimer);
      if (aiTimer !== null) window.clearInterval(aiTimer);
    };
  }, [enabled, assessmentType, attemptId, config, accommodation]);
}
