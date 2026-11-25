import { describe, expect, it } from 'vitest';
import {
  fileForLang,
  labelForLang,
  LANG_FILES,
  LANG_ORDER,
  STARTER_CODE,
  starterForLang,
} from '../../src/lib/logic/starters';

describe('language starters and filenames', () => {
  it('defines exact filenames and starter templates for all 6 supported languages', () => {
    expect(LANG_ORDER).toEqual(['c', 'cpp', 'java', 'python', 'rust', 'go']);
    expect(LANG_FILES).toEqual({
      c: 'main.c',
      cpp: 'main.cpp',
      java: 'Main.java',
      python: 'main.py',
      rust: 'main.rs',
      go: 'main.go',
    });

    for (const lang of LANG_ORDER) {
      expect(fileForLang(lang)).toBeTruthy();
      expect(labelForLang(lang)).toBeTruthy();
      expect(STARTER_CODE[lang].length).toBeGreaterThan(20);
      expect(starterForLang(lang)).toBe(STARTER_CODE[lang]);
    }
  });
});
