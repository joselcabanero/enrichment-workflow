import { clusterCpc } from "../cpc.js";
import { getConfig } from "../config.js";
import { fetchJson, HttpError } from "../http.js";
import type { CompanyData, PatentInfo, PatentRef } from "../types.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * EPO Open Patent Services (OPS) — free EPO API covering EP, WO and worldwide
 * (DOCDB) publications, filling the gap PatentsView (US-only) leaves for
 * European startups. Requires EPO_OPS_KEY + EPO_OPS_SECRET (free registration).
 *
 * Uses the biblio search so one call yields the total count, publication
 * references, titles, jurisdictions AND CPC classifications — which we cluster
 * into a technology fingerprint. Matches by applicant name (`pa="…"`); early IP
 * is often filed under a founder or university, so a zero here isn't "no IP" —
 * the per-founder verify links (patentSearch) cover that.
 */

const AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken";
const BIBLIO_URL = "https://ops.epo.org/3.2/rest-services/published-data/search/biblio";
const MAX_DOCS = 25;

/** OPS wraps scalar values as { "$": "value" }. */
function val(x: unknown): string | undefined {
  if (x && typeof x === "object" && "$" in (x as Record<string, unknown>)) {
    const v = (x as Record<string, unknown>)["$"];
    return typeof v === "string" ? v : undefined;
  }
  return typeof x === "string" ? x : undefined;
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

async function getToken(key: string, secret: string): Promise<string> {
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new HttpError(`EPO auth failed (HTTP ${res.status})`, res.status, AUTH_URL);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("EPO auth returned no access_token");
  return json.access_token;
}

/** Pull the English (or first) invention title from a bibliographic-data node. */
function title(biblio: Record<string, unknown>): string | undefined {
  const titles = asArray(biblio["invention-title"] as unknown);
  const en = titles.find(
    (t) => (t as Record<string, unknown>)?.["@lang"] === "en",
  ) as Record<string, unknown> | undefined;
  return val(en ?? titles[0]);
}

/** Earliest 4-digit year among priority claims / application reference. */
function earliestYear(biblio: Record<string, unknown>): number | undefined {
  const years: number[] = [];
  const collect = (dateNode: unknown) => {
    const d = val((dateNode as Record<string, unknown>)?.date);
    const y = d ? Number(d.slice(0, 4)) : NaN;
    if (Number.isFinite(y) && y > 1900) years.push(y);
  };
  const claims = biblio["priority-claims"] as Record<string, unknown> | undefined;
  for (const pc of asArray(claims?.["priority-claim"] as unknown)) {
    collect((pc as Record<string, unknown>)["document-id"]);
  }
  const appRef = biblio["application-reference"] as Record<string, unknown> | undefined;
  collect(appRef?.["document-id"]);
  return years.length ? Math.min(...years) : undefined;
}

/** Collect full CPC subclass symbols (e.g. "A23L") from a bibliographic-data node. */
function cpcSymbols(biblio: Record<string, unknown>): string[] {
  const container = biblio["patent-classifications"] as Record<string, unknown> | undefined;
  const list = asArray(container?.["patent-classification"] as unknown);
  const out: string[] = [];
  for (const pc of list) {
    const c = pc as Record<string, unknown>;
    const scheme = c["classification-scheme"] as Record<string, unknown> | undefined;
    const isCpc = (val(scheme?.["@scheme"]) ?? scheme?.["@scheme"]) === "CPC";
    if (scheme && !isCpc) continue; // keep CPC; skip IPC etc. (keep if unmarked)
    const sym = `${val(c.section) ?? ""}${val(c.class) ?? ""}${val(c.subclass) ?? ""}`;
    if (sym.length >= 4) out.push(sym);
  }
  return out;
}

export async function fetchEpo(ctx: SourceContext): Promise<SourceResult> {
  const { epoConsumerKey, epoConsumerSecret } = getConfig();
  if (!epoConsumerKey || !epoConsumerSecret) {
    return { source: "epo", status: "skipped", detail: "no EPO_OPS_KEY / EPO_OPS_SECRET set" };
  }

  try {
    const token = await getToken(epoConsumerKey, epoConsumerSecret);
    const q = `pa="${ctx.name.replace(/"/g, "")}"`;
    const url = `${BIBLIO_URL}?q=${encodeURIComponent(q)}&Range=1-${MAX_DOCS}`;
    const res = await fetchJson<Record<string, any>>(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });

    const search = res?.["ops:world-patent-data"]?.["ops:biblio-search"];
    const total = Number(search?.["@total-result-count"] ?? "0");
    if (!total || Number.isNaN(total)) {
      return { source: "epo", status: "no_match", detail: `no EPO applicant match for "${ctx.name}"` };
    }

    // exchange-documents → exchange-document (both can be obj or array).
    const containers = asArray(search?.["ops:search-result"]?.["exchange-documents"]);
    const docs: Record<string, any>[] = [];
    for (const c of containers) docs.push(...asArray((c as any)?.["exchange-document"]));

    const jurisdictions = new Set<string>();
    const families = new Set<string>();
    const allCpc: string[] = [];
    const recent: PatentRef[] = [];
    const priorityYears: number[] = [];
    let granted = 0;
    let pending = 0;
    for (const doc of docs) {
      const country = doc["@country"];
      const num = doc["@doc-number"];
      const kind = doc["@kind"];
      if (typeof country === "string") jurisdictions.add(country);
      if (typeof doc["@family-id"] === "string") families.add(doc["@family-id"]);
      // Kind-code proxy for legal status: B* = grant, A* = application.
      if (typeof kind === "string") {
        if (/^B/i.test(kind)) granted++;
        else if (/^A/i.test(kind)) pending++;
      }
      const biblio = doc["bibliographic-data"] as Record<string, unknown> | undefined;
      if (biblio) {
        allCpc.push(...cpcSymbols(biblio));
        const y = earliestYear(biblio);
        if (y) priorityYears.push(y);
      }
      if (recent.length < 6 && typeof country === "string" && typeof num === "string") {
        const id = `${country}${num}${typeof kind === "string" ? kind : ""}`;
        recent.push({
          id,
          ...(biblio ? { title: title(biblio) } : {}),
          url: `https://patents.google.com/patent/${id}/en`,
        });
      }
    }

    const patents: PatentInfo = { count: total, status: "granted/applications (EPO worldwide)" };
    if (families.size) patents.familyCount = families.size;
    if (granted) patents.grantedCount = granted;
    if (pending) patents.pendingCount = pending;
    if (priorityYears.length) {
      const earliest = Math.min(...priorityYears);
      patents.earliestPriorityYear = earliest;
      patents.estimatedCoreExpiryYear = earliest + 20;
    }
    if (jurisdictions.size) patents.jurisdictions = [...jurisdictions];
    if (recent.length) patents.recent = recent;
    const cpc = clusterCpc(allCpc);
    if (cpc.length) patents.cpc = cpc;
    patents.assignee = ctx.name;

    const data: Partial<CompanyData> = { patents };
    return { source: "epo", status: "ok", data };
  } catch (err) {
    const detail =
      err instanceof HttpError && (err.status === 400 || err.status === 403)
        ? "EPO OPS credentials rejected"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "epo", status: "error", detail };
  }
}
