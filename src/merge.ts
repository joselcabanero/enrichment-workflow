import type {
  CompanyData,
  CompanyField,
  Headquarters,
  Provenance,
  SocialLinks,
  SourceName,
} from "./types.js";
import type { SourceResult } from "./sources/types.js";

/**
 * Per-field source precedence. The first source in the list that supplies a
 * non-empty value wins the merged value; every contributing source is recorded
 * in provenance regardless of who won.
 */
const PRECEDENCE: Record<string, SourceName[]> = {
  // Descriptive — Wikidata is editorially richer.
  name: ["wikidata", "apollo", "dealroom"],
  description: ["wikidata", "apollo", "dealroom"],
  founders: ["wikidata", "web", "apollo"],
  ceo: ["wikidata", "apollo"],
  products: ["wikidata", "web"],
  parentCompany: ["wikidata"],
  // Traction signals — web research only.
  accelerators: ["web"],
  corporatePartners: ["web"],
  productStage: ["web"],
  trl: ["web"],
  foundedDate: ["wikidata", "apollo"],
  foundedYear: ["wikidata", "apollo"],
  website: ["wikidata", "apollo", "dealroom"],
  // Firmographics — Apollo/Dealroom are the specialists.
  domain: ["apollo", "dealroom", "wikidata"],
  industry: ["apollo", "dealroom", "wikidata"],
  categories: ["apollo", "dealroom", "wikidata"],
  employeeCount: ["apollo", "dealroom", "wikidata"],
  employeeRange: ["apollo", "wikidata"],
  logoUrl: ["apollo", "wikidata"],
  // Revenue / stock — Apollo is the specialist.
  revenue: ["apollo", "dealroom", "wikidata"],
  headcountGrowthYoY: ["apollo"],
  stockSymbol: ["apollo", "wikidata"],
  stockExchange: ["apollo", "wikidata"],
  // Funding — Dealroom is the specialist, then web research, then Apollo.
  fundingTotal: ["dealroom", "web", "apollo", "wikidata"],
  latestFundingStage: ["dealroom", "web", "apollo"],
  lastFundingDate: ["dealroom", "web", "apollo"],
  valuation: ["dealroom", "wikidata"],
  investors: ["dealroom", "web"],
  growthStage: ["dealroom"],
  dealroomUrl: ["dealroom"],
  // Legal entity — OpenCorporates authoritative.
  legalName: ["opencorporates", "apollo", "wikidata"],
  legalEntity: ["opencorporates"],
  // Wikidata-only.
  wikipediaUrl: ["wikidata"],
  wikidataId: ["wikidata"],
};

/** Object fields whose sub-fields are merged across sources rather than replaced. */
const OBJECT_FIELDS: Record<string, SourceName[]> = {
  headquarters: ["apollo", "dealroom", "wikidata"],
  socialLinks: ["apollo", "wikidata"],
  // Patents merge across offices: EPO gives the worldwide count + EP/WO
  // publications, PatentsView adds US grants, web adds areas/status/summary.
  patents: ["epo", "patentsview", "web"],
};

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Merge source results into one CompanyData plus a provenance map. */
export function mergeResults(results: SourceResult[]): {
  company: CompanyData;
  provenance: Provenance;
} {
  const bySource = new Map<SourceName, Partial<CompanyData>>();
  for (const r of results) {
    if (r.status === "ok" && r.data) bySource.set(r.source, r.data);
  }

  const company: CompanyData = {};
  const provenance: Provenance = {};

  // Simple + array + legalEntity fields via precedence.
  for (const [field, order] of Object.entries(PRECEDENCE)) {
    const contributors: SourceName[] = [];
    let chosen: unknown;
    for (const source of order) {
      const value = bySource.get(source)?.[field as CompanyField];
      if (!isEmpty(value)) {
        contributors.push(source);
        if (chosen === undefined) chosen = value;
      }
    }
    if (chosen !== undefined) {
      (company as Record<string, unknown>)[field] = chosen;
      provenance[field as CompanyField] = contributors;
    }
  }

  // Object fields: merge sub-fields across sources (higher precedence wins per key).
  for (const [field, order] of Object.entries(OBJECT_FIELDS)) {
    const merged: Record<string, unknown> = {};
    const contributors = new Set<SourceName>();
    // Iterate low -> high precedence so higher precedence overwrites.
    for (const source of [...order].reverse()) {
      const obj = bySource.get(source)?.[field as CompanyField] as
        | Record<string, unknown>
        | undefined;
      if (!obj) continue;
      for (const [k, v] of Object.entries(obj)) {
        if (!isEmpty(v)) {
          merged[k] = v;
          contributors.add(source);
        }
      }
    }
    if (Object.keys(merged).length) {
      (company as Record<string, unknown>)[field] = merged as Headquarters | SocialLinks;
      provenance[field as CompanyField] = [...contributors];
    }
  }

  return { company, provenance };
}
