import { describe, expect, it } from 'vitest';
import { inferBloomLevel, inferCoPoLevels } from '../../src/lib/logic/bloom';

describe('inferBloomLevel', () => {
  it('detects remember, understand, apply, analyze, evaluate, and create verbs', () => {
    expect(inferBloomLevel('Define pointers and arrays').btl).toBe(1);
    expect(inferBloomLevel('Understand memory allocation').btl).toBe(2);
    expect(inferBloomLevel('Implement linked lists in C').btl).toBe(3);
    expect(inferBloomLevel('Analyze time complexity of sorting').btl).toBe(4);
    expect(inferBloomLevel('Evaluate algorithm trade-offs').btl).toBe(5);
    expect(inferBloomLevel('Design a concurrent task scheduler').btl).toBe(6);
  });

  it('defaults to L3 Apply when no known verb is present', () => {
    expect(inferBloomLevel('Pointers and recursion').btl).toBe(3);
  });
});

describe('inferCoPoLevels', () => {
  it('maps technical CO statements to PO and PSO codes', () => {
    const levels = inferCoPoLevels('Design and implement data structures using modern Python tools', 6, [
      { code: 'PO1', statement: 'Engineering knowledge' },
      { code: 'PO3', statement: 'Design/development of solutions' },
      { code: 'PO5', statement: 'Modern tool usage' },
      { code: 'PSO1', statement: 'Build Python software solutions' },
    ]);
    const byCode = new Map(levels.map((l) => [l.po_code, l.level]));
    expect(byCode.get('PO3')).toBe(3);
    expect(byCode.get('PO5')).toBe(3);
    expect(byCode.get('PSO1')).toBe(3);
  });
});
