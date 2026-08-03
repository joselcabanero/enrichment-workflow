import { getConfig } from "../config.js";
import { fetchJson, HttpError } from "../http.js";
import type { Candidate, CompanyData, LegalEntity, Person } from "../types.js";
import { nameSimilarity } from "../util.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * OpenCorporates legal-entity data. Requires OPENCORPORATES_API_TOKEN on every
 * request (no anonymous access). Best-effort match by name similarity; when
 * several plausible entities match, they are returned as candidates.
 */

const BASE = "https://api.opencorporates.com/v0.4";
const MATCH_THRESHOLD = 0.5;

interface OcCompany {
  name?: string;
  company_number?: string;
  jurisdiction_code?: string;
  incorporation_date?: string;
  dissolution_date?: string;
  company_type?: string;
  current_status?: string;
  registry_url?: string;
  opencorporates_url?: string;
  registered_address_in_full?: string;
  officers?: { officer?: { name?: string; position?: string } }[];
}

interface SearchResponse {
  results?: {
    companies?: { company: OcCompany }[];
  };
}

interface CompanyResponse {
  results?: { company?: OcCompany };
}

function mapCompany(c: OcCompany): LegalEntity {
  const entity: LegalEntity = {};
  if (c.company_number) entity.companyNumber = c.company_number;
  if (c.jurisdiction_code) entity.jurisdiction = c.jurisdiction_code;
  if (c.incorporation_date) entity.incorporationDate = c.incorporation_date;
  if (c.company_type) entity.type = c.company_type;
  if (c.current_status) entity.status = c.current_status;
  if (c.registry_url) entity.registryUrl = c.registry_url;
  if (c.opencorporates_url) entity.openCorporatesUrl = c.opencorporates_url;
  const officers: Person[] = (c.officers ?? [])
    .map((o) => o.officer)
    .filter((o): o is { name?: string; position?: string } => !!o?.name)
    .map((o) => ({ name: o.name!, role: o.position }));
  if (officers.length) entity.officers = officers;
  return entity;
}

export async function fetchOpenCorporates(ctx: SourceContext): Promise<SourceResult> {
  const { openCorporatesToken } = getConfig();
  if (!openCorporatesToken) {
    return {
      source: "opencorporates",
      status: "skipped",
      detail: "no OPENCORPORATES_API_TOKEN set",
    };
  }

  try {
    const searchUrl = `${BASE}/companies/search?q=${encodeURIComponent(
      ctx.name,
    )}&order=score&api_token=${encodeURIComponent(openCorporatesToken)}`;
    const search = await fetchJson<SearchResponse>(searchUrl);
    const companies = (search.results?.companies ?? []).map((c) => c.company);
    if (companies.length === 0) {
      return { source: "opencorporates", status: "no_match", detail: "no company registration found" };
    }

    // Rank by name similarity; prefer active companies on ties.
    const ranked = companies
      .map((c) => ({ c, score: nameSimilarity(ctx.name, c.name ?? "") }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aActive = /active/i.test(a.c.current_status ?? "") ? 1 : 0;
        const bActive = /active/i.test(b.c.current_status ?? "") ? 1 : 0;
        return bActive - aActive;
      });

    const best = ranked[0]!;
    if (best.score < MATCH_THRESHOLD) {
      // Too uncertain to assert one — surface candidates instead of guessing.
      const candidates: Candidate[] = ranked.slice(0, 5).map((r) => ({
        name: r.c.name ?? "(unknown)",
        jurisdiction: r.c.jurisdiction_code,
        identifier: r.c.company_number,
        hint: r.c.current_status,
      }));
      return {
        source: "opencorporates",
        status: "no_match",
        detail: `no confident legal-entity match for "${ctx.name}"`,
        candidates,
      };
    }

    const entity = mapCompany(best.c);

    // Fetch full record for officers/details when we have jurisdiction + number.
    if (entity.jurisdiction && entity.companyNumber && !entity.officers) {
      try {
        const detail = await fetchJson<CompanyResponse>(
          `${BASE}/companies/${entity.jurisdiction}/${encodeURIComponent(
            entity.companyNumber,
          )}?api_token=${encodeURIComponent(openCorporatesToken)}`,
        );
        if (detail.results?.company) Object.assign(entity, mapCompany(detail.results.company));
      } catch {
        /* detail fetch is best-effort */
      }
    }

    const data: Partial<CompanyData> = { legalEntity: entity };
    if (best.c.name) data.legalName = best.c.name;

    // When >1 plausible match, still expose the alternatives.
    const others = ranked.filter((r) => r.score >= MATCH_THRESHOLD).slice(1, 5);
    const candidates: Candidate[] | undefined = others.length
      ? others.map((r) => ({
          name: r.c.name ?? "(unknown)",
          jurisdiction: r.c.jurisdiction_code,
          identifier: r.c.company_number,
          hint: r.c.current_status,
        }))
      : undefined;

    return { source: "opencorporates", status: "ok", data, candidates };
  } catch (err) {
    const detail =
      err instanceof HttpError && (err.status === 401 || err.status === 403)
        ? "OPENCORPORATES_API_TOKEN rejected"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "opencorporates", status: "error", detail };
  }
}
