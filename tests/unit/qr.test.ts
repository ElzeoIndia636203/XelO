import { describe, expect, it } from 'vitest';
import { qrSvgData, verificationCode } from '../../src/lib/logic/qr';
import { buildZip } from '../../src/lib/logic/zip';

describe('QR verification and bulk ZIP builder', () => {
  it('generates deterministic XO verification code and crisp SVG QR path', () => {
    const code = verificationCode('CSL-101', '2301034', 'student-uuid-1');
    expect(code).toMatch(/^XO-CSL101-2301034-[0-9A-F]{4}$/);
    expect(code).toBe(verificationCode('csl 101', '2301034', 'student-uuid-1'));

    const svg = qrSvgData('https://xeio.in/app/verify/c1/s1');
    expect(svg.size).toBeGreaterThanOrEqual(21);
    expect(svg.path).toContain('M0,0h1v1h-1z');
  });

  it('builds a valid PKZIP archive containing all student lab files', () => {
    const bytes = buildZip([
      { name: '2301001.html', content: '<html><body>Aarav</body></html>' },
      { name: '2301002.html', content: '<html><body>Diya</body></html>' },
    ]);
    // Local file header PK\x03\x04
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain('2301001.html');
    expect(decoded).toContain('Diya');
  });
});
