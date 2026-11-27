import { useCallback, useEffect, useState } from 'react';
import { Banner, Card, Chip } from './ui';
import {
  resolveEffectiveRules,
  type ProctorConfig,
  type StudentAccommodation,
} from '../lib/logic/proctor';
import {
  checkSingleMonitor,
  requestCameraAndMic,
  requestEntireScreenShare,
  requestExamFullscreen,
} from '../lib/proctor-runtime';

export interface SecureStartRecord {
  browser: string;
  singleMonitor: boolean;
  vmDetected: boolean;
  rttMs: number;
  screenShareOk: boolean;
  cameraOk: boolean;
  micOk: boolean;
  consentAccepted: boolean;
}

const VIRTUAL_CAM_KEYWORDS = ['obs', 'manycam', 'snap camera', 'xsplit', 'droidcam'];
const VM_RENDERERS = ['swiftshader', 'vmware', 'virtualbox', 'llvmpipe', 'microsoft basic render'];

function detectVmRenderer(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return false;
    const renderer = String((gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
    return VM_RENDERERS.some((k) => renderer.includes(k));
  } catch {
    return false;
  }
}

export function SecureCheckPanel({
  config,
  accommodation,
  onReadyToStart,
}: {
  config: ProctorConfig;
  accommodation?: Partial<StudentAccommodation>;
  onReadyToStart: (record: SecureStartRecord) => void | Promise<void>;
}) {
  const effective = resolveEffectiveRules(config, accommodation);
  const [singleMonitor, setSingleMonitor] = useState(() => checkSingleMonitor());
  const [vmDetected] = useState(() => detectVmRenderer());
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [camOk, setCamOk] = useState(!effective.cameraRequired);
  const [micOk, setMicOk] = useState(!effective.micRequired);
  const [screenOk, setScreenOk] = useState(!effective.screenShareRequired);
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const measurePing = useCallback(async () => {
    const t0 = performance.now();
    try {
      await fetch(window.location.origin, { method: 'HEAD', cache: 'no-store' });
      setRttMs(Math.round(performance.now() - t0));
    } catch {
      setRttMs(999);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void measurePing(), 0);
    const mon = window.setInterval(() => setSingleMonitor(checkSingleMonitor()), 5000);
    return () => {
      window.clearTimeout(id);
      window.clearInterval(mon);
    };
  }, [measurePing]);

  async function enableCamMic() {
    setMsg(null);
    try {
      const stream = await requestCameraAndMic();
      const vTrack = stream.getVideoTracks()[0];
      const label = (vTrack?.label ?? '').toLowerCase();
      if (effective.cameraRequired && VIRTUAL_CAM_KEYWORDS.some((k) => label.includes(k))) {
        setMsg(`Virtual camera (${vTrack?.label}) is blocked by PC-04. Select a physical webcam.`);
        return;
      }
      setCamOk(true);
      setMicOk(true);
    } catch {
      setMsg('Camera/microphone permission is required for this proctoring level.');
    }
  }

  async function enableScreenShare() {
    setMsg(null);
    try {
      const res = await requestEntireScreenShare();
      if (!res.entireScreen) {
        setMsg('PC-06 requires sharing your Entire screen (not a single tab or window).');
        setScreenOk(false);
        return;
      }
      setScreenOk(true);
    } catch {
      setMsg('Entire-screen share permission was cancelled.');
    }
  }

  const allChecksPass =
    singleMonitor &&
    (!effective.cameraRequired || camOk) &&
    (!effective.micRequired || micOk) &&
    (!effective.screenShareRequired || screenOk) &&
    consent;

  async function handleStart() {
    if (!allChecksPass) return;
    setBusy(true);
    setMsg(null);
    try {
      const fs = await requestExamFullscreen();
      if (!fs) {
        setMsg('PC-10 requires fullscreen mode. Allow fullscreen and try again.');
        setBusy(false);
        return;
      }
      await onReadyToStart({
        browser: navigator.userAgent.slice(0, 120),
        singleMonitor,
        vmDetected,
        rttMs: rttMs ?? 0,
        screenShareOk: screenOk,
        cameraOk: camOk,
        micOk,
        consentAccepted: consent,
      });
    } finally {
      setBusy(false);
    }
  }

  const levelLabel =
    config.level === 3 ? 'Level 3 · High' : config.level === 2 ? 'Level 2 · Moderate' : 'Level 1 · Minimum';

  return (
    <Card
      title="Pre-assessment secure check"
      actions={<Chip tone={config.level === 3 ? 'warn' : 'good'}>{levelLabel}</Chip>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
        {msg ? <Banner tone="err">{msg}</Banner> : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Chip tone={singleMonitor ? 'good' : 'bad'}>
            PC-07 Single display: {singleMonitor ? 'Pass' : 'Extra display detected'}
          </Chip>
          <Chip tone={vmDetected ? 'warn' : 'good'}>
            PC-09 Environment: {vmDetected ? 'VM/remote flagged (S2)' : 'Standard'}
          </Chip>
          <Chip tone={(rttMs ?? 0) <= 800 ? 'good' : 'warn'}>
            PC-11 Network: {rttMs !== null ? `${rttMs} ms` : 'Checking…'}
          </Chip>
        </div>

        {(effective.cameraRequired || effective.micRequired) ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>
              PC-04/05: {effective.cameraRequired ? 'Camera' : ''}
              {effective.cameraRequired && effective.micRequired ? ' & ' : ''}
              {effective.micRequired ? 'Microphone' : ''}
            </span>
            <button type="button" className="btn field-sm" onClick={() => void enableCamMic()}>
              {camOk && micOk ? 'Ready' : 'Enable camera / mic'}
            </button>
          </div>
        ) : null}

        {effective.screenShareRequired ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>PC-06: Share entire screen (monitor surface)</span>
            <button type="button" className="btn field-sm" onClick={() => void enableScreenShare()}>
              {screenOk ? 'Entire screen shared' : 'Share entire screen'}
            </button>
          </div>
        ) : null}

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, padding: 10, background: 'var(--bg-subtle)', borderRadius: 6 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong>PC-12 Monitoring notice (DPDP Act 2023):</strong> This assessment uses {levelLabel}.
            No continuous video or audio is recorded; event snapshots/screen frames are captured only on proctor alerts and retained for 90 days.
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!allChecksPass || busy}
            onClick={() => void handleStart()}
          >
            {busy ? 'Starting…' : 'Enter fullscreen & start assessment'}
          </button>
        </div>
      </div>
    </Card>
  );
}
