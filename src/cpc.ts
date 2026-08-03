import type { CpcCluster } from "./types.js";

/**
 * CPC (Cooperative Patent Classification) labelling + clustering.
 *
 * CPC symbols look like "A23L 27/00". The first four characters are the
 * *subclass* (section letter + 2-digit class + subclass letter) — the right
 * grain for a technology fingerprint. We label a curated set of subclasses
 * relevant to foodtech / agtech / biotech / AI-sensing, and fall back to the
 * section meaning for anything else.
 */

const SECTION: Record<string, string> = {
  A: "Human necessities",
  B: "Operations & transport",
  C: "Chemistry & metallurgy",
  D: "Textiles & paper",
  E: "Fixed constructions",
  F: "Mechanical engineering",
  G: "Physics",
  H: "Electricity",
  Y: "Emerging cross-sectional tech",
};

const SUBCLASS: Record<string, string> = {
  A01B: "Agriculture — soil working",
  A01G: "Horticulture / cultivation",
  A01H: "New plants / breeding",
  A01N: "Biocides / pest control",
  A21D: "Baking / dough",
  A22C: "Meat / fish processing",
  A23B: "Preserving foods",
  A23C: "Dairy products",
  A23D: "Edible oils & fats",
  A23G: "Cocoa / confectionery",
  A23J: "Protein compositions",
  A23K: "Animal feed",
  A23L: "Foods & foodstuffs",
  A23P: "Shaping / treating foodstuffs",
  B29C: "Shaping plastics (incl. 3D printing)",
  B33Y: "Additive manufacturing (3D printing)",
  B41J: "Printing / inkjet",
  C07K: "Peptides / proteins",
  C08L: "Macromolecular compositions",
  C11B: "Oils & fats",
  C12M: "Bioreactors / apparatus",
  C12N: "Microorganisms / enzymes / genetic eng.",
  C12P: "Fermentation / biosynthesis",
  C12Q: "Enzymatic / nucleic-acid assays",
  C12R: "Microorganisms (indexing)",
  G01J: "Spectrometry",
  G01N: "Investigating materials (analysis/sensing)",
  G05B: "Control systems",
  G06F: "Digital data processing",
  G06N: "AI / machine learning",
  G06Q: "Business / commerce methods",
  G06T: "Image data processing",
  G06V: "Image / video recognition",
  G16B: "Bioinformatics",
  G16Y: "Internet of Things",
  H04N: "Image communication",
  Y02A: "Climate change adaptation",
  Y02P: "Climate mitigation in production",
};

/** Label for a CPC subclass code (e.g. "A23L"). */
export function cpcLabel(subclass: string): string | undefined {
  const code = subclass.toUpperCase();
  if (SUBCLASS[code]) return SUBCLASS[code];
  const section = SECTION[code[0] ?? ""];
  return section ? `${section} (${code})` : undefined;
}

/** Extract the 4-char subclass (e.g. "A23L") from a full CPC symbol. */
export function toSubclass(symbol: string): string | undefined {
  const m = /^\s*([A-HY])\s*(\d{2})\s*([A-Z])/.exec(symbol.toUpperCase());
  return m ? `${m[1]}${m[2]}${m[3]}` : undefined;
}

/**
 * Cluster a list of full CPC symbols by subclass, count them, and label them —
 * returning the top clusters, most-frequent first.
 */
export function clusterCpc(symbols: string[], top = 8): CpcCluster[] {
  const counts = new Map<string, number>();
  for (const sym of symbols) {
    const sub = toSubclass(sym);
    if (sub) counts.set(sub, (counts.get(sub) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([code, count]) => ({ code, count, ...(cpcLabel(code) ? { label: cpcLabel(code) } : {}) }));
}
