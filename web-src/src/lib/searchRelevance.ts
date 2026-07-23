/** Normalize a set of hybrid-search scores to a [floor, 1] ratio for a
 *  relative match-strength bar. Hybrid RRF scores have no absolute
 *  meaning, so this only communicates strength relative to the current
 *  result set: the strongest hit fills the bar, the weakest keeps a
 *  visible floor, and an all-equal set (including a single result) fills
 *  every bar. Order-independent: the ratio for a score does not depend on
 *  the position it is passed in. */
const RELEVANCE_FLOOR = 0.2;

export function relevanceRatios(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (max === min) return scores.map(() => 1);
  return scores.map((score) => RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * ((score - min) / (max - min)));
}
