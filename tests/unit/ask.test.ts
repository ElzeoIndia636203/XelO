import { describe, expect, it } from 'vitest';
import { parseAskCommand } from '../../src/lib/logic/ask';

describe('Ask box parser', () => {
  it('routes session numbers, roll numbers, and step keywords', () => {
    expect(parseAskCommand('open S13')).toMatchObject({ step: 'sessions', sessionNumber: 13 });
    expect(parseAskCommand('show 2301044')).toMatchObject({ step: 'sessions', inspectRoll: '2301044' });
    expect(parseAskCommand('session plan')).toMatchObject({ step: 'plan' });
    expect(parseAskCommand('batches and roster')).toMatchObject({ step: 'batches' });
    expect(parseAskCommand('download course file')).toMatchObject({ step: 'reports', reportTab: 'file' });
  });
});
