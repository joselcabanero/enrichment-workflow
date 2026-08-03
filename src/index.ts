import { categorize } from "./categorize.js";
import { mergeResults } from "./merge.js";
import { buildPatentSearch } from "./patentSearch.js";
import { renderMarkdown } from "./report.js";
import { domainFromResult, resolveInput } from "./resolve.js";
import { fetchApollo } from "./sources/apollo.js";
import { fetchDealroom } from "./sources/dealroom.js";
import { fetchEpo } from "./sources/epo.js";
import { fetchOpenCorporates } from "./sources/opencorporates.js";
import { fetchPatents } from "./sources/patents.js";
import { fetchResearch } from "./sources/research.js";
import { fetchWikidata } from "./sources/wikidata.js";
import type { SourceContext, SourceResult } from "./sources/types.js";
import type { EnrichInput, EnrichmentResult, SourceName, SourceStatus } from "./types.js";

export type {
  Candidate,
  CompanyData,
  EnrichInput,
  EnrichmentResult,
  LegalEntity,
  Person,
  Provenance,
  SourceName,
  SourceStatus,
} from "./types.js";

/**
 * Enrich a startup by name (and optional domain) from free-tier sources.
 *
 * Flow:
 *  1. Wikidata (keyless) runs first — it also yields an official domain that
 *     lets Apollo enrich by domain instead of a fuzzy name search.
 *  2. Apollo + OpenCorporates run in parallel with the resolved domain.
 *  3. Results are merged into one record with per-field provenance, plus a
 *     markdown brief. Any source without credentials is reported as "skipped";
 *     a slow/failing source never blocks the others.
 */
export async function enrich(input: EnrichInput): Promise<EnrichmentResult> {
  const { name, domain: givenDomain } = resolveInput(input);

  // Phase 1: Wikidata (always runs, keyless).
  const wikidataResult = await settle("wikidata", () => fetchWikidata({ name, domain: givenDomain }));
  const resolvedDomain = givenDomain ?? domainFromResult(wikidataResult);
  const ctx: SourceContext = { name, domain: resolvedDomain };

  // Phase 2: remaining sources in parallel (keyed; skip fast if no credential).
  const [apolloResult, dealroomResult, ocResult, patentsResult, epoResult, researchResult] =
    await Promise.all([
      settle("apollo", () => fetchApollo(ctx)),
      settle("dealroom", () => fetchDealroom(ctx)),
      settle("opencorporates", () => fetchOpenCorporates(ctx)),
      settle("patentsview", () => fetchPatents(ctx)),
      settle("epo", () => fetchEpo(ctx)),
      settle("web", () => fetchResearch(ctx)),
    ]);

  const results: SourceResult[] = [
    wikidataResult,
    apolloResult,
    dealroomResult,
    ocResult,
    patentsResult,
    epoResult,
    researchResult,
  ];
  const { company, provenance } = mergeResults(results);

  // Deterministic patent-verification links — always available, no API cost.
  const searchName = company.name ?? name;
  if (searchName) company.patentSearch = buildPatentSearch(searchName, company.founders);

  const sources: SourceStatus[] = results.map((r) => ({
    source: r.source,
    status: r.status,
    detail: r.detail,
    candidates: r.candidates,
  }));

  // Optional: classify against the caller's own taxonomy (needs it + a key).
  const classification = input.taxonomy?.length
    ? await categorize(company, input.taxonomy)
    : undefined;

  const markdown = renderMarkdown(input, company, provenance, sources, classification);
  return {
    input: { name, ...(givenDomain ? { domain: givenDomain } : {}) },
    company,
    provenance,
    sources,
    ...(classification ? { classification } : {}),
    markdown,
  };
}

/** Run a source adapter, converting any thrown error into an "error" result. */
async function settle(
  source: SourceName,
  fn: () => Promise<SourceResult>,
): Promise<SourceResult> {
  try {
    return await fn();
  } catch (err) {
    return { source, status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
