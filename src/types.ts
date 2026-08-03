/**
 * Public types for the startup enrichment module.
 */

/** Names of the data sources this module can query. */
export type SourceName =
  | "wikidata"
  | "apollo"
  | "dealroom"
  | "opencorporates"
  | "patentsview"
  | "epo"
  | "web";

/** All source names, in a stable order. */
export const SOURCE_NAMES: SourceName[] = [
  "wikidata",
  "apollo",
  "dealroom",
  "opencorporates",
  "patentsview",
  "epo",
  "web",
];

/** A node in the caller's own taxonomy/ontology (e.g. exported from their DB). */
export interface TaxonomyNode {
  /** Stable ID from the caller's system — echoed back on assignments so results join. */
  id: string;
  name: string;
  /** Definition/description — greatly improves classification accuracy when present. */
  description?: string;
  /** Parent node ID, for hierarchical taxonomies. */
  parentId?: string;
  /**
   * Dimension slug for multi-dimensional taxonomies (e.g. "application_domain").
   * When nodes carry dimensions, the company is classified independently within
   * each dimension and {@link Classification.dimensions} is populated.
   */
  dimension?: string;
}

/** One category assignment against the caller's taxonomy. */
export interface CategoryAssignment {
  id: string;
  name: string;
  confidence?: "low" | "medium" | "high";
  rationale?: string;
}

/**
 * Classification within one dimension of a multi-dimensional taxonomy.
 * Exactly one of three outcomes:
 * - classified: `primary` set (+ optional `secondary`), both flags unset;
 * - not applicable: `notApplicable` true — no term in this dimension applies
 *   to this company (a valid answer, e.g. a CPG brand has no tech stack);
 * - needs review: `needsReview` true — evidence too thin to decide; route to
 *   a human.
 */
export interface DimensionClassification {
  /** Dimension slug, as carried on the taxonomy nodes (e.g. "application_domain"). */
  dimension: string;
  primary?: CategoryAssignment;
  secondary?: CategoryAssignment[];
  /** True when this dimension genuinely does not apply to the company. */
  notApplicable?: boolean;
  /** True when nothing could be confidently assigned — route to manual review. */
  needsReview?: boolean;
}

/** Result of classifying a company against the caller's taxonomy. */
export interface Classification {
  /** Best single category (flat taxonomies; unset when `dimensions` is used). */
  primary?: CategoryAssignment;
  secondary?: CategoryAssignment[];
  /** Flat taxonomies: true when no category genuinely applies (valid answer). */
  notApplicable?: boolean;
  /**
   * Per-dimension results, present when the taxonomy nodes carry `dimension`
   * (e.g. Jarvis DB's application_domain / market_application / technology_stack).
   * Each dimension is classified independently.
   */
  dimensions?: DimensionClassification[];
  /** True when nothing in the taxonomy (or any dimension) fits well. */
  needsReview?: boolean;
}

/** Input to {@link enrich}. */
export interface EnrichInput {
  /** Startup / company name. Required. */
  name: string;
  /** Optional domain or URL to disambiguate (e.g. "stripe.com" or "https://stripe.com"). */
  domain?: string;
  /**
   * The caller's own taxonomy. When provided (with an Anthropic key), the
   * company is classified strictly against it and the result carries category
   * IDs from the caller's system. Omit to skip classification.
   */
  taxonomy?: TaxonomyNode[];
}

/** A cluster of patents under one CPC subclass (e.g. "A23L" → Foods). */
export interface CpcCluster {
  /** CPC subclass, e.g. "A23L". */
  code: string;
  /** Human-readable label for the subclass/section. */
  label?: string;
  /** Number of filings touching this subclass (EPO); absent for web estimates. */
  count?: number;
}

/** A person associated with the company (founder, officer). */
export interface Person {
  name: string;
  /** Role, when known (e.g. "founder", "director"). */
  role?: string;
}

/** Legal-registration data, primarily from OpenCorporates. */
export interface LegalEntity {
  companyNumber?: string;
  jurisdiction?: string;
  incorporationDate?: string;
  type?: string;
  status?: string;
  registryUrl?: string;
  openCorporatesUrl?: string;
  officers?: Person[];
}

export interface Headquarters {
  city?: string;
  region?: string;
  country?: string;
}

export interface SocialLinks {
  linkedin?: string;
  twitter?: string;
  facebook?: string;
  crunchbase?: string;
  github?: string;
}

/** A single patent grant/application. */
export interface PatentRef {
  id: string;
  title?: string;
  date?: string;
  url?: string;
}

/**
 * Aggregated patent / IP portfolio. Structured US grants come from PatentsView;
 * the qualitative picture (jurisdictions, status, areas, notable filings) is
 * filled by web research so it also covers EU/PCT filings and spin-out IP.
 */
export interface PatentInfo {
  /** Total publications matched to the company. */
  count?: number;
  /** Distinct patent families (one invention, filed in several offices). */
  familyCount?: number;
  /** Publications with a grant kind code. */
  grantedCount?: number;
  /** Publications still at application stage. */
  pendingCount?: number;
  /** Earliest priority year — the IP vintage. */
  earliestPriorityYear?: number;
  /** Estimated core-protection expiry (earliest priority + 20 years). */
  estimatedCoreExpiryYear?: number;
  /** The assignee name matched (for traceability). */
  assignee?: string;
  /** A few most-recent structured grants (PatentsView). */
  recent?: PatentRef[];
  /** "granted" | "pending" | "mixed". */
  status?: string;
  /** Patent offices / jurisdictions, e.g. ["EP", "US", "WO/PCT"]. */
  jurisdictions?: string[];
  /** Technology areas the IP covers. */
  areas?: string[];
  /** Notable patent / application titles surfaced from the web. */
  notable?: string[];
  /** CPC technology clusters — verified from EPO filings, or web-estimated. */
  cpc?: CpcCluster[];
  /** One-line IP assessment (web-derived). */
  summary?: string;
}

/** A ready-made patent-database search link. */
export interface PatentSearchLink {
  label: string;
  url: string;
}

/**
 * Deterministic "go verify" links into Google Patents and Espacenet, by
 * company (applicant/assignee) and by founder (inventor). Computed from the
 * name and founders — no API, always available, even on a keyless run.
 */
export interface PatentSearchLinks {
  company: PatentSearchLink[];
  byInventor?: { name: string; links: PatentSearchLink[] }[];
}

/** A corporate the startup engages with (investor, partner, customer, pilot). */
export interface CorporatePartner {
  name: string;
  /** Relationship type, e.g. "investor", "partner", "customer", "pilot". */
  relationship?: string;
}

/**
 * Technology Readiness Level (1-9), derived from traction evidence. This is an
 * estimate, not a stated fact — always carries a rationale and a confidence.
 */
export interface Trl {
  level?: number;
  rationale?: string;
  confidence?: "low" | "medium" | "high";
}

/** Normalized, merged company record. All fields optional. */
export interface CompanyData {
  name?: string;
  legalName?: string;
  domain?: string;
  website?: string;
  description?: string;
  foundedYear?: number;
  foundedDate?: string;
  founders?: Person[];
  ceo?: string;
  headquarters?: Headquarters;
  industry?: string;
  categories?: string[];
  products?: string[];
  parentCompany?: string;
  /** Accelerator / incubator programs the startup has joined. */
  accelerators?: string[];
  /** Corporates the startup engages with (investors, partners, customers). */
  corporatePartners?: CorporatePartner[];
  /** Commercial maturity, e.g. "on market", "pilot", "prototype", "R&D". */
  productStage?: string;
  /** Derived Technology Readiness Level (1-9) with rationale. */
  trl?: Trl;
  employeeCount?: number;
  employeeRange?: string;
  revenue?: number;
  fundingTotal?: number;
  latestFundingStage?: string;
  lastFundingDate?: string;
  valuation?: number;
  investors?: string[];
  growthStage?: string;
  headcountGrowthYoY?: number;
  stockSymbol?: string;
  stockExchange?: string;
  socialLinks?: SocialLinks;
  logoUrl?: string;
  wikipediaUrl?: string;
  wikidataId?: string;
  dealroomUrl?: string;
  patents?: PatentInfo;
  /** Deterministic patent-database verification links (always computed). */
  patentSearch?: PatentSearchLinks;
  legalEntity?: LegalEntity;
}

/** Keys of {@link CompanyData} that carry provenance. */
export type CompanyField = keyof CompanyData;

/** Maps each populated field to the source(s) that supplied it. */
export type Provenance = Partial<Record<CompanyField, SourceName[]>>;

/** Outcome of querying a single source. */
export type SourceStatusKind = "ok" | "no_match" | "skipped" | "error";

export interface SourceStatus {
  source: SourceName;
  status: SourceStatusKind;
  /** Human-readable detail (e.g. "no APOLLO_API_KEY set", "request timed out"). */
  detail?: string;
  /** Alternative matches surfaced when the name was ambiguous. */
  candidates?: Candidate[];
}

/** A possible match when a name resolves to more than one plausible entity. */
export interface Candidate {
  name: string;
  domain?: string;
  jurisdiction?: string;
  identifier?: string;
  hint?: string;
}

/** The full result returned by {@link enrich}. */
export interface EnrichmentResult {
  input: EnrichInput;
  company: CompanyData;
  provenance: Provenance;
  sources: SourceStatus[];
  /** Present only when a taxonomy was supplied and classification ran. */
  classification?: Classification;
  markdown: string;
}
