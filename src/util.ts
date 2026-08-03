/** Shared small helpers. */

/**
 * Normalize a domain or URL to a bare lowercase host (no scheme, no www, no
 * path). Returns undefined for empty/invalid input.
 */
export function normalizeDomain(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (!s.includes("://")) s = `https://${s}`;
  try {
    const host = new URL(s).hostname;
    return host.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Lowercased, punctuation-stripped form for loose name comparison. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|sa|sl|bv|plc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cheap similarity in [0,1]: token overlap (Jaccard) of normalized names. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** First defined, non-empty value. */
export function firstDefined<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
