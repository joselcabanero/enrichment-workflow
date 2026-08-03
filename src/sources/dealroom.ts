import { getConfig } from "../config.js";
import { fetchJson, HttpError } from "../http.js";
import type { CompanyData } from "../types.js";
import { nameSimilarity, normalizeDomain } from "../util.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * Dealroom company data (funding, valuation, investors, growth stage).
 * Requires DEALROOM_API_KEY — Dealroom has no free tier; full API access is a
 * paid subscription, so this adapter is skipped when no key is present.
 *
 * NOTE: exercised only with a real key. The auth scheme and a few field names
 * below follow Dealroom's documented v2 company schema; if your account's API
 * contract differs, adjust `AUTH_HEADER` and the mappings in `mapCompany`.
 */

const BASE = "https://api.dealroom.co/api/v2/companies";
const MATCH_THRESHOLD = 0.5;

interface DrInvestor {
  name?: string;
}
interface DrLocation {
  city?: string;
  country?: string;
}
interface DrCompany {
  id?: number;
  name?: string;
  tagline?: string;
  website_url?: string;
  url?: string;
  path?: string;
  total_funding?: number;
  total_funding_source?: { amount?: number };
  last_funding?: string;
  last_round?: string;
  last_funding_date?: string;
  valuation?: number;
  growth_stage?: string;
  employees_latest?: number;
  employees?: number;
  industries?: string[];
  tags?: string[];
  investors?: DrInvestor[];
  hq_locations?: DrLocation[];
}

interface DrResponse {
  items?: DrCompany[];
}

function num(...vals: (number | undefined)[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function mapCompany(c: DrCompany): Partial<CompanyData> {
  const data: Partial<CompanyData> = {};
  if (c.name) data.name = c.name;
  if (c.tagline) data.description = c.tagline;

  const website = c.website_url ?? c.url;
  if (website) {
    data.website = website;
    const dom = normalizeDomain(website);
    if (dom) data.domain = dom;
  }
  if (c.path) data.dealroomUrl = `https://app.dealroom.co/companies/${c.path}`;

  const funding = num(c.total_funding, c.total_funding_source?.amount);
  if (funding !== undefined) data.fundingTotal = funding;
  const stage = c.last_funding ?? c.last_round;
  if (stage) data.latestFundingStage = stage;
  if (c.last_funding_date) data.lastFundingDate = c.last_funding_date;
  if (c.valuation !== undefined) data.valuation = c.valuation;
  if (c.growth_stage) data.growthStage = c.growth_stage;

  const employees = num(c.employees_latest, c.employees);
  if (employees !== undefined) data.employeeCount = employees;

  const cats = [...(c.industries ?? []), ...(c.tags ?? [])].filter(Boolean);
  if (cats.length) {
    data.industry = cats[0];
    data.categories = [...new Set(cats)].slice(0, 12);
  }

  const investors = (c.investors ?? []).map((i) => i.name).filter((n): n is string => !!n);
  if (investors.length) data.investors = investors;

  const hq = c.hq_locations?.[0];
  if (hq && (hq.city || hq.country)) {
    data.headquarters = {};
    if (hq.city) data.headquarters.city = hq.city;
    if (hq.country) data.headquarters.country = hq.country;
  }
  return data;
}

export async function fetchDealroom(ctx: SourceContext): Promise<SourceResult> {
  const { dealroomApiKey } = getConfig();
  if (!dealroomApiKey) {
    return { source: "dealroom", status: "skipped", detail: "no DEALROOM_API_KEY set" };
  }

  try {
    // Keyword search by name; Dealroom returns best matches in `items`.
    const res = await fetchJson<DrResponse>(BASE, {
      method: "POST",
      headers: {
        // Dealroom authenticates with a token in the Authorization header.
        authorization: dealroomApiKey,
        "content-type": "application/json",
      },
      json: { keyword: ctx.name, limit: 5 },
    });

    const items = res.items ?? [];
    if (items.length === 0) {
      return { source: "dealroom", status: "no_match", detail: "no company matched name" };
    }

    // Prefer a domain match, else the closest name.
    let best = items[0]!;
    if (ctx.domain) {
      const byDomain = items.find(
        (c) => normalizeDomain(c.website_url ?? c.url) === ctx.domain,
      );
      if (byDomain) best = byDomain;
    } else {
      best = items
        .map((c) => ({ c, score: nameSimilarity(ctx.name, c.name ?? "") }))
        .sort((a, b) => b.score - a.score)[0]!.c;
    }

    if (!ctx.domain && nameSimilarity(ctx.name, best.name ?? "") < MATCH_THRESHOLD) {
      return { source: "dealroom", status: "no_match", detail: "no confident name match" };
    }

    return { source: "dealroom", status: "ok", data: mapCompany(best) };
  } catch (err) {
    const detail =
      err instanceof HttpError && (err.status === 401 || err.status === 403)
        ? "DEALROOM_API_KEY rejected"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "dealroom", status: "error", detail };
  }
}
