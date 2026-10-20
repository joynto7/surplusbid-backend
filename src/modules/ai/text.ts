/** Small text utilities shared by search suggestions and recommendations. */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'into',
  'per', 'all', 'one', 'two', 'any', 'out', 'our', 'you', 'your', 'not', 'but', 'can', 'will', 'each', 'unit',
  'units', 'lot', 'lots', 'included', 'includes', 'condition', 'used', 'good', 'working', 'available', 'pickup',
  'buyer', 'seller', 'sold', 'sale', 'auction', 'machine', 'machines', 'equipment', 'new', 'like',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

/** Damerau–Levenshtein distance (optimal string alignment), capped for speed. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

/** Sparse TF-IDF vectors and cosine similarity, for content-based recommendations. */
export type Vector = Map<string, number>;

export function buildIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length || 1;
  return new Map([...df].map(([t, f]) => [t, Math.log((1 + n) / (1 + f)) + 1]));
}

export function tfidf(tokens: string[], idf: Map<string, number>): Vector {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v: Vector = new Map();
  for (const [t, f] of tf) v.set(t, (1 + Math.log(f)) * (idf.get(t) ?? 1));
  return v;
}

export function addInto(target: Vector, v: Vector, weight = 1) {
  for (const [t, x] of v) target.set(t, (target.get(t) ?? 0) + x * weight);
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [t, y] of b) {
    nb += y * y;
    const x = a.get(t);
    if (x) dot += x * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
