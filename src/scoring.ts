// ─── Score Calculation ──────────────────────────────────────────────────────
// Isolated, pure function for scoring. Easy to unit test and tune later.
//
// Formula: pointsAwarded = round(points × (0.5 + 0.5 × (remainingTimeMs / totalTimeMs)))
//   - Fast answer → full points (multiplier near 1.0)
//   - Answer at the last moment → ~50% points (multiplier near 0.5)
//   - Wrong or no answer → 0 points (handled by caller)

/**
 * Calculate the points awarded for a correct answer based on response speed.
 *
 * @param points - Base points for the question
 * @param remainingTimeMs - Milliseconds remaining when the answer was submitted
 * @param totalTimeMs - Total time limit for the question in milliseconds
 * @returns Points awarded (rounded to nearest integer), or 0 if inputs are invalid
 */
export function calculateScore(
  points: number,
  remainingTimeMs: number,
  totalTimeMs: number
): number {
  // Guard against invalid inputs
  if (points <= 0 || totalTimeMs <= 0) return 0;

  // Clamp remaining time to valid range
  const clampedRemaining = Math.max(0, Math.min(remainingTimeMs, totalTimeMs));

  const multiplier = 0.5 + 0.5 * (clampedRemaining / totalTimeMs);
  return Math.round(points * multiplier);
}
