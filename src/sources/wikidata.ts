import { fetchJson } from "../http.js";
import type { CompanyData, Person } from "../types.js";
import { normalizeDomain } from "../util.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * Keyless source: Wikidata (structured claims) + Wikipedia REST summary (clean
 * prose description). Always runs.
 *
 * Property IDs used:
 *   P571 inception, P112 founded by, P159 headquarters location,
 *   P452 industry, P856 official website, P1128 employees, P17 country,
 *   P1454 legal form, P968/P2013 socials are unreliable so we skip them.
 */

const WD_API = "https://www.wikidata.org/w/api.php";
const WP_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary";

interface WbSearchResponse {
  search?: { id: string; label?: string; description?: string }[];
}

interface WbEntity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, WbClaim[]>;
  sitelinks?: Record<string, { title: string }>;
}

interface WbDataValue {
  value: unknown;
  type?: string;
}

interface WbClaim {
  mainsnak?: {
    datavalue?: WbDataValue;
  };
}

interface WbGetEntitiesResponse {
  entities?: Record<string, WbEntity>;
}

function label(en: WbEntity | undefined): string | undefined {
  return en?.labels?.en?.value;
}

/**
 * "instance of" (P31) QIDs that indicate the entity is a company/organization,
 * used to prefer the business over a same-named place or person.
 */
const ORG_TYPES = new Set<string>([
  "Q4830453", // business
  "Q783794", // company
  "Q6881511", // enterprise
  "Q891723", // public company
  "Q167037", // corporation
  "Q18388277", // technology company
  "Q1058914", // software company
  "Q3220391", // startup company
  "Q43229", // organization
  "Q210167", // video game developer
  "Q1137109", // privately held company
]);

/** Whether the entity is instance-of (P31) any organization/company type. */
function isOrganization(entity: WbEntity): boolean {
  return entityIds(entity, "P31").some((id) => ORG_TYPES.has(id));
}

/** Extract the datavalue from each statement of a claim. */
function claimValues(entity: WbEntity, prop: string): WbDataValue[] {
  const claims = entity.claims?.[prop] ?? [];
  return claims.map((c) => c.mainsnak?.datavalue).filter((v): v is WbDataValue => !!v);
}

function entityIds(entity: WbEntity, prop: string): string[] {
  const out: string[] = [];
  for (const dv of claimValues(entity, prop)) {
    const v = dv.value as { id?: string } | undefined;
    if (v?.id) out.push(v.id);
  }
  return out;
}

function timeValue(entity: WbEntity, prop: string): string | undefined {
  for (const dv of claimValues(entity, prop)) {
    const v = dv.value as { time?: string } | undefined;
    if (v?.time) {
      // Wikidata times look like "+2010-00-00T00:00:00Z"; strip leading + and zero months/days.
      const m = /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(v.time);
      if (m) {
        const [, y, mo, d] = m;
        if (mo === "00") return y;
        if (d === "00") return `${y}-${mo}`;
        return `${y}-${mo}-${d}`;
      }
    }
  }
  return undefined;
}

function stringValue(entity: WbEntity, prop: string): string | undefined {
  for (const dv of claimValues(entity, prop)) {
    if (typeof dv.value === "string") return dv.value;
  }
  return undefined;
}

function quantityValue(entity: WbEntity, prop: string): number | undefined {
  for (const dv of claimValues(entity, prop)) {
    const v = dv.value as { amount?: string } | undefined;
    if (v?.amount) {
      const n = Number(v.amount);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** Batch-resolve a set of QIDs to their English labels in one API call. */
async function resolveLabels(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return out;
  const url = `${WD_API}?action=wbgetentities&ids=${unique.join(
    "|",
  )}&props=labels&languages=en&format=json&origin=*`;
  const res = await fetchJson<WbGetEntitiesResponse>(url);
  for (const [id, en] of Object.entries(res.entities ?? {})) {
    const l = label(en);
    if (l) out.set(id, l);
  }
  return out;
}

export async function fetchWikidata(ctx: SourceContext): Promise<SourceResult> {
  try {
    // 1. Search for the entity by name (top few candidates).
    const searchUrl = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(
      ctx.name,
    )}&language=en&type=item&limit=5&format=json&origin=*`;
    const search = await fetchJson<WbSearchResponse>(searchUrl);
    const hits = search.search ?? [];
    const top = hits[0];
    if (!top) {
      return { source: "wikidata", status: "no_match", detail: "no Wikidata entity found" };
    }
    const hitById = new Map(hits.map((h) => [h.id, h]));

    // 2. Fetch full data for all candidates in one call, then disambiguate.
    const ids = hits.map((h) => h.id);
    const entUrl = `${WD_API}?action=wbgetentities&ids=${ids.join(
      "|",
    )}&props=labels|descriptions|claims|sitelinks&languages=en&format=json&origin=*`;
    const entRes = await fetchJson<WbGetEntitiesResponse>(entUrl);

    // Disambiguate by scoring candidates: an official-website (P856) match with
    // the given domain is decisive; being instance-of an organization/company
    // outweighs a same-named place or person; search rank breaks ties. This
    // stops collisions like "Vercel" the company vs. the French commune from
    // silently resolving to the wrong entity.
    let chosenId = top.id;
    let bestScore = -Infinity;
    ids.forEach((id, index) => {
      const cand = entRes.entities?.[id];
      if (!cand) return;
      let score = ids.length - index; // higher search rank = small bonus
      if (isOrganization(cand)) score += 100;
      if (ctx.domain) {
        const site = stringValue(cand, "P856");
        if (site && normalizeDomain(site) === ctx.domain) score += 1000;
      }
      if (score > bestScore) {
        bestScore = score;
        chosenId = id;
      }
    });

    const chosenHit = hitById.get(chosenId) ?? top;
    const entity = entRes.entities?.[chosenId];
    if (!entity) {
      return { source: "wikidata", status: "no_match", detail: "entity not retrievable" };
    }

    // 3. Resolve referenced QIDs (founders, CEO, HQ, industry, country, parent,
    //    products) to English labels in one batched call.
    const founderIds = entityIds(entity, "P112");
    const ceoIds = entityIds(entity, "P169");
    const hqIds = entityIds(entity, "P159");
    const industryIds = entityIds(entity, "P452");
    const countryIds = entityIds(entity, "P17");
    const parentIds = entityIds(entity, "P749");
    const productIds = entityIds(entity, "P1056");
    const labels = await resolveLabels([
      ...founderIds,
      ...ceoIds,
      ...hqIds,
      ...industryIds,
      ...countryIds,
      ...parentIds,
      ...productIds,
    ]);

    const data: Partial<CompanyData> = {};
    data.wikidataId = chosenId;
    data.name = label(entity) ?? chosenHit.label;
    data.description = entity.descriptions?.en?.value ?? chosenHit.description;

    const website = stringValue(entity, "P856");
    if (website) {
      data.website = website;
      const dom = normalizeDomain(website);
      if (dom) data.domain = dom;
    }

    const founded = timeValue(entity, "P571");
    if (founded) {
      data.foundedDate = founded;
      const year = Number(founded.slice(0, 4));
      if (Number.isFinite(year)) data.foundedYear = year;
    }

    const founders: Person[] = founderIds
      .map((id) => labels.get(id))
      .filter((n): n is string => !!n)
      .map((name) => ({ name, role: "founder" }));
    if (founders.length) data.founders = founders;

    const ceo = ceoIds.map((id) => labels.get(id)).find(Boolean);
    if (ceo) data.ceo = ceo;

    const parent = parentIds.map((id) => labels.get(id)).find(Boolean);
    if (parent) data.parentCompany = parent;

    const products = productIds.map((id) => labels.get(id)).filter((n): n is string => !!n);
    if (products.length) data.products = products.slice(0, 10);

    const industry = industryIds.map((id) => labels.get(id)).filter((n): n is string => !!n);
    if (industry.length) {
      data.industry = industry[0];
      data.categories = industry;
    }

    const hqCity = hqIds.map((id) => labels.get(id)).find(Boolean);
    const country = countryIds.map((id) => labels.get(id)).find(Boolean);
    if (hqCity || country) {
      data.headquarters = {};
      if (hqCity) data.headquarters.city = hqCity;
      if (country) data.headquarters.country = country;
    }

    const employees = quantityValue(entity, "P1128");
    if (employees !== undefined) data.employeeCount = employees;

    // Verified external identifiers -> canonical profile URLs.
    const social: NonNullable<CompanyData["socialLinks"]> = {};
    const twitter = stringValue(entity, "P2002");
    if (twitter) social.twitter = `https://twitter.com/${twitter}`;
    const linkedin = stringValue(entity, "P4264");
    if (linkedin) social.linkedin = `https://www.linkedin.com/company/${linkedin}`;
    const facebook = stringValue(entity, "P2013");
    if (facebook) social.facebook = `https://www.facebook.com/${facebook}`;
    const github = stringValue(entity, "P2037");
    if (github) social.github = `https://github.com/${github}`;
    const crunchbase = stringValue(entity, "P2088");
    if (crunchbase) social.crunchbase = `https://www.crunchbase.com/organization/${crunchbase}`;
    if (Object.keys(social).length) data.socialLinks = social;

    // Logo (P154) is a Wikimedia Commons filename -> stable file URL.
    const logo = stringValue(entity, "P154");
    if (logo) {
      data.logoUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
        logo,
      )}?width=256`;
    }

    // 4. Wikipedia article: URL + a cleaner prose description.
    const enwiki = entity.sitelinks?.enwiki?.title;
    if (enwiki) {
      data.wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
        enwiki.replace(/ /g, "_"),
      )}`;
      try {
        const summary = await fetchJson<{ extract?: string }>(
          `${WP_SUMMARY}/${encodeURIComponent(enwiki)}`,
        );
        if (summary.extract) data.description = summary.extract;
      } catch {
        /* summary is a nice-to-have; ignore failures */
      }
    }

    return { source: "wikidata", status: "ok", data };
  } catch (err) {
    return {
      source: "wikidata",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
