import { getConfig } from "../config.js";
import { fetchJson, HttpError } from "../http.js";
import type { CompanyData, PatentRef } from "../types.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * Patent portfolio via the PatentsView Search API (USPTO data).
 * Endpoint: https://search.patentsview.org/api/v1/patent/
 * Requires PATENTSVIEW_API_KEY (X-Api-Key header) — a free key requested from
 * PatentsView. Skipped when no key is present.
 *
 * We match on assignee organization name. USPTO records name grantees, so the
 * result is patents *assigned to* the company (not necessarily filed by it).
 */

const BASE = "https://search.patentsview.org/api/v1/patent/";
const MAX_RECENT = 5;

interface PvPatent {
  patent_id?: string;
  patent_title?: string;
  patent_date?: string;
  assignees?: { assignee_organization?: string }[];
}

interface PvResponse {
  error?: boolean;
  count?: number;
  total_hits?: number;
  patents?: PvPatent[];
}

export async function fetchPatents(ctx: SourceContext): Promise<SourceResult> {
  const { patentsviewApiKey } = getConfig();
  if (!patentsviewApiKey) {
    return { source: "patentsview", status: "skipped", detail: "no PATENTSVIEW_API_KEY set" };
  }

  try {
    // Query: patents whose assignee organization contains the company name.
    const q = { _text_phrase: { "assignees.assignee_organization": ctx.name } };
    const f = JSON.stringify([
      "patent_id",
      "patent_title",
      "patent_date",
      "assignees.assignee_organization",
    ]);
    const o = JSON.stringify({ size: MAX_RECENT });
    const s = JSON.stringify([{ patent_date: "desc" }]);
    const url =
      `${BASE}?q=${encodeURIComponent(JSON.stringify(q))}` +
      `&f=${encodeURIComponent(f)}&o=${encodeURIComponent(o)}&s=${encodeURIComponent(s)}`;

    const res = await fetchJson<PvResponse>(url, {
      method: "GET",
      headers: { "x-api-key": patentsviewApiKey },
    });

    const total = res.total_hits ?? res.count ?? 0;
    if (!total || !res.patents?.length) {
      return { source: "patentsview", status: "no_match", detail: "no patents matched assignee" };
    }

    const recent: PatentRef[] = res.patents.slice(0, MAX_RECENT).map((p) => ({
      id: p.patent_id ?? "",
      title: p.patent_title?.trim(),
      date: p.patent_date,
      url: p.patent_id ? `https://patents.google.com/patent/US${p.patent_id}` : undefined,
    }));

    const assignee = res.patents[0]?.assignees?.[0]?.assignee_organization;
    const data: Partial<CompanyData> = {
      patents: { count: total, assignee, recent },
    };
    return { source: "patentsview", status: "ok", data };
  } catch (err) {
    const detail =
      err instanceof HttpError && (err.status === 401 || err.status === 403)
        ? "PATENTSVIEW_API_KEY rejected"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "patentsview", status: "error", detail };
  }
}
