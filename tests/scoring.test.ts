import { describe, it, expect } from 'vitest';
import { calculateScore } from '../src/scoring';

describe('calculateScore', () => {
  it('returns full points for instant answer', () => {
    // remainingTime = totalTime → multiplier = 1.0
    expect(calculateScore(100, 20000, 20000)).toBe(100);
  });

  it('returns ~50% points for last-moment answer', () => {
    // remainingTime = 0 → multiplier = 0.5
    expect(calculateScore(100, 0, 20000)).toBe(50);
  });

  it('returns ~75% points for half-time answer', () => {
    // remainingTime = 10000, totalTime = 20000 → multiplier = 0.75
    expect(calculateScore(100, 10000, 20000)).toBe(75);
  });

  it('rounds to nearest integer', () => {
    // 150 * (0.5 + 0.5 * (7000/20000)) = 150 * 0.675 = 101.25 → 101
    expect(calculateScore(150, 7000, 20000)).toBe(101);
  });

  it('returns 0 for zero points', () => {
    expect(calculateScore(0, 10000, 20000)).toBe(0);
  });

  it('returns 0 for negative points', () => {
    expect(calculateScore(-100, 10000, 20000)).toBe(0);
  });

  it('returns 0 for zero total time', () => {
    expect(calculateScore(100, 5000, 0)).toBe(0);
  });

  it('clamps negative remaining time to 0', () => {
    // Should treat as 0 remaining → 50 points
    expect(calculateScore(100, -5000, 20000)).toBe(50);
  });

  it('clamps remaining time exceeding total to total', () => {
    // Should treat as full remaining → 100 points
    expect(calculateScore(100, 25000, 20000)).toBe(100);
  });

  it('works with 150 base points', () => {
    // 150 * 1.0 = 150
    expect(calculateScore(150, 10000, 10000)).toBe(150);
    // 150 * 0.5 = 75
    expect(calculateScore(150, 0, 10000)).toBe(75);
  });
});
