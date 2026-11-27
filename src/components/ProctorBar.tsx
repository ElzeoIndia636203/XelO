import { useEffect, useRef } from 'react';
import { formatExamCountdown } from '../lib/logic/proctor';
import { getProctorStreams } from '../lib/proctor-runtime';

export function ProctorBar({
  cameraRequired,
  micRequired,
  screenShareRequired,
  cameraOk,
  micOk,
  screenOk,
  fullscreenOk,
  faceCount,
  warningCount,
  integrityScore,
  secondsLeft,
  saveLabel,
}: {
  cameraRequired: boolean;
  micRequired: boolean;
  screenShareRequired: boolean;
  cameraOk: boolean;
  micOk: boolean;
  screenOk: boolean;
  fullscreenOk: boolean;
  faceCount: number;
  warningCount: number;
  integrityScore: number;
  secondsLeft?: number | null;
  saveLabel?: string;
}) {
  const thumbRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = thumbRef.current;
    const cam = getProctorStreams().camStream;
    if (el && cam && cameraRequired) {
      el.srcObject = cam;
      void el.play().catch(() => {});
    }
  }, [cameraRequired]);

  const dot = (ok: boolean) => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: 999,
    background: ok ? '#22C55E' : '#EF4444',
    marginRight: 5,
  });

  const lowTime = typeof secondsLeft === 'number' && secondsLeft > 0 && secondsLeft < 600;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '6px 14px',
        background: '#161615',
        borderBottom: '1px solid #2C2B28',
        color: '#E8E6DF',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {cameraRequired ? (
          <video
            ref={thumbRef}
            muted
            playsInline
            style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 4, background: '#000', border: '1px solid #2C2B28' }}
          />
        ) : null}
        {cameraRequired ? (
          <span><span style={dot(cameraOk)} />Cam ({faceCount} face)</span>
        ) : null}
        {micRequired ? (
          <span><span style={dot(micOk)} />Mic</span>
        ) : null}
        {screenShareRequired ? (
          <span><span style={dot(screenOk)} />Screen</span>
        ) : null}
        <span><span style={dot(fullscreenOk)} />Fullscreen</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} className="mono">
        <span style={{ color: warningCount >= 3 ? '#F59E0B' : '#CFCDC5' }}>
          Warnings {warningCount}/3
        </span>
        <span style={{ color: integrityScore < 60 ? '#EF4444' : integrityScore < 85 ? '#F59E0B' : '#4ADE80' }}>
          Integrity {Math.round(integrityScore)}/100
        </span>
        {typeof secondsLeft === 'number' ? (
          <span style={{ fontWeight: 700, color: lowTime ? '#F97316' : '#F8FAFC' }}>
            {formatExamCountdown(secondsLeft)}
          </span>
        ) : null}
        {saveLabel ? <span style={{ color: '#94A3B8' }}>{saveLabel}</span> : null}
      </div>
    </div>
  );
}
