/** Optimal string alignment distance (Levenshtein plus adjacent transposition). */
export function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Closest candidate to `name`, or undefined when nothing is plausibly a typo.
 * A candidate qualifies when it differs only by case, is within a small edit
 * distance, or one name contains the other and they are at least half the
 * length of each other.
 */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const c = candidate.toLowerCase();
    const longest = Math.max(lower.length, c.length);
    const shortest = Math.min(lower.length, c.length);
    let score: number | undefined;
    const dist = distance(lower, c);
    const threshold = Math.max(1, Math.min(3, Math.floor(longest / 3)));
    if (dist <= threshold) score = dist;
    else if (shortest >= 3 && shortest / longest >= 0.5 && (lower.includes(c) || c.includes(lower))) {
      score = longest - shortest + 1;
    }
    if (score === undefined) continue;
    if (score < bestScore || (score === bestScore && best !== undefined && candidate < best)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
