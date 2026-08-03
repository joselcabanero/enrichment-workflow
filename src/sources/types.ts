import type { Candidate, CompanyData, SourceName, SourceStatusKind } from "../types.js";

/**
 * Normalized return value from a source adapter. Each adapter maps its raw API
 * response into a partial {@link CompanyData} plus a status describing what
 * happened, so the orchestrator can merge results uniformly.
 */
export interface SourceResult {
  source: SourceName;
  status: SourceStatusKind;
  /** Partial company data, present when status === "ok". */
  data?: Partial<CompanyData>;
  /** Detail message for skipped/error/no_match. */
  detail?: string;
  /** Ambiguous matches, when the name mapped to several plausible entities. */
  candidates?: Candidate[];
}

/** Context passed to every source adapter. */
export interface SourceContext {
  name: string;
  /** Resolved domain (bare host, no scheme), if known. */
  domain?: string;
}
