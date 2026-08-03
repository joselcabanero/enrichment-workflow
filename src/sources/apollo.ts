import { getConfig } from "../config.js";
import { fetchJson, HttpError } from "../http.js";
import type { Candidate, CompanyData } from "../types.js";
import { normalizeDomain } from "../util.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * Apollo.io organization enrichment. Requires APOLLO_API_KEY (X-Api-Key header).
 * Free plan gives 75 credits/mo; enrichment consumes credits.
 *
 *   - domain known  -> GET  /organizations/enrich?domain=
 *   - name only     -> POST /mixed_companies/search (top match) -> enrich by domain
 */

const BASE = "https://api.apollo.io/api/v1";

interface ApolloOrg {
  name?: string;
  website_url?: string;
  primary_domain?: string;
  blog_url?: string;
  linkedin_url?: string;
  twitter_url?: string;
  facebook_url?: string;
  crunchbase_url?: string;
  logo_url?: string;
  industry?: string;
  keywords?: string[];
  estimated_num_employees?: number;
  founded_year?: number;
  total_funding?: number;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  organization_revenue?: number;
  publicly_traded_symbol?: string;
  publicly_traded_exchange?: string;
  organization_headcount_twelve_month_growth?: number;
  short_description?: string;
  city?: string;
  state?: string;
  country?: string;
}

interface EnrichResponse {
  organization?: ApolloOrg;
}
interface SearchResponse {
  organizations?: ApolloOrg[];
}

function headers(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey, "content-type": "application/json" };
}

function mapOrg(org: ApolloOrg): Partial<CompanyData> {
  const data: Partial<CompanyData> = {};
  if (org.name) data.name = org.name;
  if (org.website_url) data.website = org.website_url;
  const dom = normalizeDomain(org.primary_domain ?? org.website_url);
  if (dom) data.domain = dom;
  if (org.short_description) data.description = org.short_description;
  if (org.industry) data.industry = org.industry;
  if (org.keywords?.length) data.categories = org.keywords.slice(0, 12);
  if (typeof org.estimated_num_employees === "number") data.employeeCount = org.estimated_num_employees;
  if (typeof org.founded_year === "number") data.foundedYear = org.founded_year;
  if (typeof org.total_funding === "number") data.fundingTotal = org.total_funding;
  if (org.latest_funding_stage) data.latestFundingStage = org.latest_funding_stage;
  if (org.latest_funding_round_date) data.lastFundingDate = org.latest_funding_round_date;
  if (typeof org.organization_revenue === "number") data.revenue = org.organization_revenue;
  if (org.publicly_traded_symbol) data.stockSymbol = org.publicly_traded_symbol;
  if (org.publicly_traded_exchange) data.stockExchange = org.publicly_traded_exchange;
  if (typeof org.organization_headcount_twelve_month_growth === "number")
    data.headcountGrowthYoY = org.organization_headcount_twelve_month_growth;
  if (org.logo_url) data.logoUrl = org.logo_url;

  const social: NonNullable<CompanyData["socialLinks"]> = {};
  if (org.linkedin_url) social.linkedin = org.linkedin_url;
  if (org.twitter_url) social.twitter = org.twitter_url;
  if (org.facebook_url) social.facebook = org.facebook_url;
  if (org.crunchbase_url) social.crunchbase = org.crunchbase_url;
  if (Object.keys(social).length) data.socialLinks = social;

  if (org.city || org.state || org.country) {
    data.headquarters = {};
    if (org.city) data.headquarters.city = org.city;
    if (org.state) data.headquarters.region = org.state;
    if (org.country) data.headquarters.country = org.country;
  }
  return data;
}

async function searchByName(name: string, apiKey: string): Promise<ApolloOrg[]> {
  const res = await fetchJson<SearchResponse>(`${BASE}/mixed_companies/search`, {
    method: "POST",
    headers: headers(apiKey),
    json: { q_organization_name: name, page: 1, per_page: 5 },
  });
  return res.organizations ?? [];
}

async function enrichByDomain(domain: string, apiKey: string): Promise<ApolloOrg | undefined> {
  const res = await fetchJson<EnrichResponse>(
    `${BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`,
    { method: "GET", headers: headers(apiKey) },
  );
  return res.organization;
}

export async function fetchApollo(ctx: SourceContext): Promise<SourceResult> {
  const { apolloApiKey } = getConfig();
  if (!apolloApiKey) {
    return { source: "apollo", status: "skipped", detail: "no APOLLO_API_KEY set" };
  }

  try {
    let domain = ctx.domain;

    if (!domain) {
      const matches = await searchByName(ctx.name, apolloApiKey);
      if (matches.length === 0) {
        return { source: "apollo", status: "no_match", detail: "no organization matched name" };
      }
      // If several distinct companies matched, surface candidates for the caller.
      if (matches.length > 1) {
        const candidates: Candidate[] = matches.map((m) => ({
          name: m.name ?? "(unknown)",
          domain: normalizeDomain(m.primary_domain ?? m.website_url),
          hint: m.industry,
        }));
        const best = matches[0]!;
        const data = mapOrg(best);
        return { source: "apollo", status: "ok", data, candidates };
      }
      return { source: "apollo", status: "ok", data: mapOrg(matches[0]!) };
    }

    const org = await enrichByDomain(domain, apolloApiKey);
    if (!org) {
      return { source: "apollo", status: "no_match", detail: `no org for domain ${domain}` };
    }
    return { source: "apollo", status: "ok", data: mapOrg(org) };
  } catch (err) {
    const detail =
      err instanceof HttpError && err.status === 401
        ? "APOLLO_API_KEY rejected (401)"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "apollo", status: "error", detail };
  }
}
