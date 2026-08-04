import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import { cpcLabel, toSubclass } from "../cpc.js";
import type { CompanyData, CorporatePartner, CpcCluster, PatentInfo, Person } from "../types.js";
import type { SourceContext, SourceResult } from "./types.js";

/**
 * Web-research source: uses Claude (Anthropic Messages API) with the server-side
 * web_search tool to find the facts structured databases miss — profile basics
 * (description, industry, HQ, founded, headcount range), founders, funding
 * rounds, investors, accelerator programs, corporate engagement, products, and
 * a derived Technology Readiness Level — then returns them as structured data.
 * This is the primary source for small startups the structured DBs don't cover.
 * Requires ANTHROPIC_API_KEY; skipped otherwise.
 *
 * Model-aware (cost lever): defaults to claude-haiku-4-5 (cheap) and adapts the
 * request to the model tier — Haiku uses the basic web_search tool and omits
 * adaptive thinking / effort (which it rejects); newer models get dynamic
 * filtering + adaptive thinking. Override with RESEARCH_MODEL. Sonnet 5 gives
 * more reliable TRL derivation if that accuracy matters.
 */

interface ResearchJson {
  description: string | null;
  industry: string | null;
  categories: string[];
  foundedYear: number | null;
  headquarters: { city: string | null; country: string | null };
  employeeRange: string | null;
  linkedinUrl: string | null;
  founders: { name: string }[];
  fundingTotalUsd: number | null;
  latestFundingStage: string | null;
  lastFundingDate: string | null;
  investors: string[];
  accelerators: string[];
  corporatePartners: { name: string; relationship: string | null }[];
  products: string[];
  productStage: string | null;
  trl: { level: number | null; rationale: string | null; confidence: string | null };
  patents: {
    holdsPatents: boolean | null;
    estimatedCount: number | null;
    earliestFilingYear: number | null;
    status: string | null;
    jurisdictions: string[];
    areas: string[];
    cpc: { code: string; label: string | null }[];
    notable: string[];
    summary: string | null;
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    industry: { type: ["string", "null"] },
    categories: { type: "array", items: { type: "string" } },
    foundedYear: { type: ["number", "null"] },
    headquarters: {
      type: "object",
      additionalProperties: false,
      properties: {
        city: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
      },
      required: ["city", "country"],
    },
    employeeRange: { type: ["string", "null"] },
    linkedinUrl: { type: ["string", "null"] },
    founders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    fundingTotalUsd: { type: ["number", "null"] },
    latestFundingStage: { type: ["string", "null"] },
    lastFundingDate: { type: ["string", "null"] },
    investors: { type: "array", items: { type: "string" } },
    accelerators: { type: "array", items: { type: "string" } },
    corporatePartners: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          relationship: { type: ["string", "null"] },
        },
        required: ["name", "relationship"],
      },
    },
    products: { type: "array", items: { type: "string" } },
    productStage: { type: ["string", "null"] },
    trl: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { type: ["number", "null"] },
        rationale: { type: ["string", "null"] },
        confidence: { type: ["string", "null"] },
      },
      required: ["level", "rationale", "confidence"],
    },
    patents: {
      type: "object",
      additionalProperties: false,
      properties: {
        holdsPatents: { type: ["boolean", "null"] },
        estimatedCount: { type: ["number", "null"] },
        earliestFilingYear: { type: ["number", "null"] },
        status: { type: ["string", "null"] },
        jurisdictions: { type: "array", items: { type: "string" } },
        areas: { type: "array", items: { type: "string" } },
        cpc: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              label: { type: ["string", "null"] },
            },
            required: ["code", "label"],
          },
        },
        notable: { type: "array", items: { type: "string" } },
        summary: { type: ["string", "null"] },
      },
      required: ["holdsPatents", "estimatedCount", "earliestFilingYear", "status", "jurisdictions", "areas", "cpc", "notable", "summary"],
    },
  },
  required: [
    "description",
    "industry",
    "categories",
    "foundedYear",
    "headquarters",
    "employeeRange",
    "linkedinUrl",
    "founders",
    "fundingTotalUsd",
    "latestFundingStage",
    "lastFundingDate",
    "investors",
    "accelerators",
    "corporatePartners",
    "products",
    "productStage",
    "trl",
    "patents",
  ],
} as const;

const PROMPT_TAIL =
  `Return, from reputable sources only (null / empty when unknown — do not guess):\n` +
  `- description: 1-2 factual sentences on what the company makes or does (no marketing language)\n` +
  `- industry: one short line (e.g. "Food production"); categories: up to 6 short tags (e.g. "Biotechnology", "Alternative proteins")\n` +
  `- foundedYear; headquarters city + country\n` +
  `- employeeRange: approximate headcount bracket from public info (e.g. "11-50") — a range, never an exact invented number\n` +
  `- linkedinUrl: the company's LinkedIn page URL, only if unambiguous\n` +
  `- founders (full names)\n` +
  `- total funding raised to date in USD; the most recent round (stage + date YYYY-MM); known investors\n` +
  `- accelerator / incubator programs the company has joined (e.g. Y Combinator, EIT Food, Eatable Adventures, Start it @KBC)\n` +
  `- corporate engagement: named corporates it works with as investor, partner, customer or pilot (with the relationship)\n` +
  `- products or services it actually sells, and productStage: one of "on market", "pilot", "prototype/demo", "R&D", or "pre-product"\n` +
  `- trl: derive a Technology Readiness Level 1-9 from the evidence, with a one-line rationale and a confidence of low/medium/high. Rubric: ` +
  `9 = sold at commercial scale; 8 = product launched / first commercial sales; 7 = pilot at scale in operational use; ` +
  `6 = prototype demonstrated in a relevant environment; 5 = validated in a relevant environment; 4 = lab validation; ` +
  `3 = proof of concept; 1-2 = basic research. Prefer the lower level when evidence is thin.\n` +
  `- patents / IP: does the company hold patents or applications? Give an approximate count (patent families), the earliest filing/priority year if known, status ("granted"/"pending"/"mixed"), ` +
  `jurisdictions (e.g. US, EP, WO/PCT), key technology areas, and — as best you can infer from the technology — likely CPC classification subclasses ` +
  `as {code, label} (e.g. {"code":"A23L","label":"Foods"}, {"code":"B33Y","label":"Additive manufacturing"}, {"code":"C12N","label":"Microorganisms/enzymes"}). ` +
  `Also give notable patent or application titles and a one-line IP assessment. Check Google Patents / Espacenet. ` +
  `If the company is a university spin-off, note the core IP may sit with the university.`;

/** Older/Haiku tiers use the basic web_search tool and no adaptive thinking/effort. */
function isBasicTier(model: string): boolean {
  return /haiku|opus-4-5|sonnet-4-5|claude-3/.test(model);
}

function extractJson(content: Anthropic.ContentBlock[]): ResearchJson | undefined {
  const texts = content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const last = texts[texts.length - 1]?.text?.trim();
  if (!last) return undefined;
  const cleaned = last.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as ResearchJson;
  } catch {
    return undefined;
  }
}

export async function fetchResearch(ctx: SourceContext): Promise<SourceResult> {
  const { anthropicApiKey, researchModel } = getConfig();
  if (!anthropicApiKey) {
    return { source: "web", status: "skipped", detail: "no ANTHROPIC_API_KEY set" };
  }

  const model = researchModel ?? "claude-haiku-4-5";
  const basic = isBasicTier(model);
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const who = ctx.domain ? `${ctx.name} (${ctx.domain})` : ctx.name;
  const prompt = `Research the startup ${who} using web search.\n${PROMPT_TAIL}`;

  // Model-aware request: basic tiers (Haiku) use the classic web_search tool and
  // omit adaptive thinking / effort, which those models reject.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool: any = basic
    ? { type: "web_search_20250305", name: "web_search", max_uses: 8 }
    : { type: "web_search_20260209", name: "web_search", max_uses: 8 };

  const build = (
    messages: Anthropic.MessageParam[],
  ): Anthropic.Messages.MessageCreateParamsNonStreaming => {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 8000,
      tools: [tool],
      output_config: basic
        ? { format: { type: "json_schema", schema: SCHEMA } }
        : { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages,
    };
    if (!basic) params.thinking = { type: "adaptive" };
    return params;
  };

  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let response = await client.messages.create(build(messages));

    let guard = 0;
    while (response.stop_reason === "pause_turn" && guard++ < 4) {
      messages.push({ role: "assistant", content: response.content });
      response = await client.messages.create(build(messages));
    }

    if (response.stop_reason === "refusal") {
      return { source: "web", status: "error", detail: "request refused" };
    }

    const parsed = extractJson(response.content);
    if (!parsed) {
      return { source: "web", status: "error", detail: "could not parse research output" };
    }

    const data: Partial<CompanyData> = {};
    if (parsed.description) data.description = parsed.description;
    if (parsed.industry) data.industry = parsed.industry;
    const categories = (parsed.categories ?? []).filter(Boolean);
    if (categories.length) data.categories = categories;
    if (typeof parsed.foundedYear === "number" && parsed.foundedYear > 1800) {
      data.foundedYear = parsed.foundedYear;
    }
    if (parsed.headquarters?.city || parsed.headquarters?.country) {
      data.headquarters = {
        ...(parsed.headquarters.city ? { city: parsed.headquarters.city } : {}),
        ...(parsed.headquarters.country ? { country: parsed.headquarters.country } : {}),
      };
    }
    if (parsed.employeeRange) data.employeeRange = parsed.employeeRange;
    if (parsed.linkedinUrl?.startsWith("http")) data.socialLinks = { linkedin: parsed.linkedinUrl };
    const founders: Person[] = (parsed.founders ?? [])
      .map((f) => f.name)
      .filter((n): n is string => !!n)
      .map((name) => ({ name, role: "founder" }));
    if (founders.length) data.founders = founders;
    if (typeof parsed.fundingTotalUsd === "number") data.fundingTotal = parsed.fundingTotalUsd;
    if (parsed.latestFundingStage) data.latestFundingStage = parsed.latestFundingStage;
    if (parsed.lastFundingDate) data.lastFundingDate = parsed.lastFundingDate;
    const investors = (parsed.investors ?? []).filter(Boolean);
    if (investors.length) data.investors = investors;

    const accelerators = (parsed.accelerators ?? []).filter(Boolean);
    if (accelerators.length) data.accelerators = accelerators;

    const partners: CorporatePartner[] = (parsed.corporatePartners ?? [])
      .filter((p) => p?.name)
      .map((p) => ({ name: p.name, ...(p.relationship ? { relationship: p.relationship } : {}) }));
    if (partners.length) data.corporatePartners = partners;

    const products = (parsed.products ?? []).filter(Boolean);
    if (products.length) data.products = products;
    if (parsed.productStage) data.productStage = parsed.productStage;

    if (parsed.trl && typeof parsed.trl.level === "number") {
      data.trl = {
        level: parsed.trl.level,
        ...(parsed.trl.rationale ? { rationale: parsed.trl.rationale } : {}),
        ...(parsed.trl.confidence === "low" ||
        parsed.trl.confidence === "medium" ||
        parsed.trl.confidence === "high"
          ? { confidence: parsed.trl.confidence }
          : {}),
      };
    }

    const pj = parsed.patents;
    if (pj) {
      const pat: PatentInfo = {};
      if (typeof pj.estimatedCount === "number") pat.count = pj.estimatedCount;
      if (typeof pj.earliestFilingYear === "number" && pj.earliestFilingYear > 1900) {
        pat.earliestPriorityYear = pj.earliestFilingYear;
        pat.estimatedCoreExpiryYear = pj.earliestFilingYear + 20;
      }
      if (pj.status) pat.status = pj.status;
      const juris = (pj.jurisdictions ?? []).filter(Boolean);
      if (juris.length) pat.jurisdictions = juris;
      const areas = (pj.areas ?? []).filter(Boolean);
      if (areas.length) pat.areas = areas;
      const notable = (pj.notable ?? []).filter(Boolean);
      if (notable.length) pat.notable = notable;
      const cpc: CpcCluster[] = [];
      for (const entry of pj.cpc ?? []) {
        const sub = toSubclass(entry?.code ?? "");
        if (sub && !cpc.some((x) => x.code === sub)) {
          cpc.push({ code: sub, label: cpcLabel(sub) ?? entry.label ?? undefined });
        }
      }
      if (cpc.length) pat.cpc = cpc;
      if (pj.summary) pat.summary = pj.summary;
      else if (pj.holdsPatents === false) pat.summary = "No patents identified.";
      if (Object.keys(pat).length) data.patents = pat;
    }

    if (Object.keys(data).length === 0) {
      return { source: "web", status: "no_match", detail: "no facts found" };
    }
    return { source: "web", status: "ok", data };
  } catch (err) {
    const detail =
      err instanceof Anthropic.AuthenticationError
        ? "ANTHROPIC_API_KEY rejected"
        : err instanceof Error
          ? err.message
          : String(err);
    return { source: "web", status: "error", detail };
  }
}
