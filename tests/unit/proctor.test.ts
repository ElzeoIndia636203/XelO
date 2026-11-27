import { describe, expect, it } from 'vitest';
import {
  analyzeBurstShare,
  analyzeCodeInsert,
  analyzeKeystrokeTimings,
  applyProctorWarning,
  computeIntegrityBand,
  defaultProctorConfig,
  normalizeProctorMedia,
  resolveEffectiveRules,
} from '../../src/lib/logic/proctor';

describe('Proctoring Rulebook Logic', () => {
  it('defaults to Level 2 (Moderate) with screen share on and camera/mic off', () => {
    const cfg = defaultProctorConfig();
    expect(cfg.level).toBe(2);
    expect(cfg.media).toEqual({ camera: false, microphone: false, screenShare: true });
    const eff = resolveEffectiveRules(cfg);
    expect(eff.cameraRequired).toBe(false);
    expect(eff.micRequired).toBe(false);
    expect(eff.screenShareRequired).toBe(true);
    expect(eff.enabledRules.has('BL-01')).toBe(true);
    expect(eff.enabledRules.has('PC-06')).toBe(true);
    expect(eff.enabledRules.has('AI-01')).toBe(false);
  });

  it('forces all media on at Level 3 and all media off at Level 1', () => {
    expect(normalizeProctorMedia(3, { camera: false, microphone: false, screenShare: false })).toEqual({
      camera: true,
      microphone: true,
      screenShare: true,
    });
    expect(normalizeProctorMedia(1, { camera: true, microphone: true, screenShare: true })).toEqual({
      camera: false,
      microphone: false,
      screenShare: false,
    });
  });

  it('applies student accommodations on top of Level 3', () => {
    const cfg = defaultProctorConfig(3);
    const eff = resolveEffectiveRules(cfg, {
      no_camera: true,
      relax_screen_reader: true,
      scribe_reader: true,
    });
    expect(eff.cameraRequired).toBe(false);
    expect(eff.enabledRules.has('AI-01')).toBe(false);
    expect(eff.enabledRules.has('BL-13')).toBe(false);
    expect(eff.enabledRules.has('SC-01')).toBe(false);
    expect(eff.enabledRules.has('AU-01')).toBe(false);
  });

  it('computes integrity bands and 3-warning flag without auto-termination', () => {
    expect(computeIntegrityBand(90, false)).toBe('clean');
    expect(computeIntegrityBand(72, false)).toBe('review_suggested');
    expect(computeIntegrityBand(55, false)).toBe('review_required');
    expect(computeIntegrityBand(95, true)).toBe('review_required');
    const w3 = applyProctorWarning(2);
    expect(w3.flagged).toBe(true);
    expect(w3.terminated).toBe(false);
  });

  it('detects CB-01 large external insert, CB-02 auto-typer, and CB-03 burst share', () => {
    expect(analyzeCodeInsert(85, false)).toBe(true);
    expect(analyzeCodeInsert(85, true)).toBe(false);
    expect(analyzeKeystrokeTimings(Array.from({ length: 100 }, () => 8))).toBe(true);
    expect(analyzeKeystrokeTimings(Array.from({ length: 100 }, () => 80))).toBe(false);
    expect(analyzeBurstShare(800, 1000, 25)).toBe(true);
    expect(analyzeBurstShare(800, 1000, 10)).toBe(false);
  });
});
