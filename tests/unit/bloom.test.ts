import { describe, expect, it } from 'vitest';
import { inferBloomLevel } from '../../src/lib/logic/bloom';

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
