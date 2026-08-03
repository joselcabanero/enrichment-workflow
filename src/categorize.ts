import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config.js";
import { isTechnologyCpc } from "./cpc.js";
import type {
  CategoryAssignment,
  Classification,
  CompanyData,
  CpcCluster,
  DimensionClassification,
  TaxonomyNode,
} from "./types.js";

/**
 * Classify a company strictly against the caller's own taxonomy. Returns
 * category assignments carrying the caller's IDs (validated against the
 * supplied nodes) plus confidence, rationale, and a needsReview flag when
 * nothing fits. Never invents categories.
 *
 * Flat taxonomies get a single primary + secondaries. When nodes carry a
 * `dimension` (e.g. Jarvis DB's application_domain / market_application /
 * technology_stack), each dimension is classified independently in one API
 * call and `classification.dimensions` is populated instead.
 *
 * Requires ANTHROPIC_API_KEY. Uses RESEARCH_MODEL (default claude-haiku-4-5) —
 * classification is a cheap reasoning task; bump to sonnet-5 for a large or
 * subtle taxonomy.
 */

interface DimJson {
  outcome: "classified" | "not_applicable" | "needs_review";
  primaryId: string | null;
  primaryConfidence: string | null;
  primaryRationale: string | null;
  secondary: { id: string; confidence: string | null; rationale: string | null }[];
}

function isBasicTier(model: string): boolean {
  return /haiku|opus-4-5|sonnet-4-5|claude-3/.test(model);
}

function conf(v: string | null): CategoryAssignment["confidence"] {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

/** A compact, classification-relevant summary of the enriched profile. */
function profileText(c: CompanyData): string {
  const parts: string[] = [];
  if (c.name) parts.push(`Name: ${c.name}`);
  if (c.description) parts.push(`Description: ${c.description}`);
  if (c.industry) parts.push(`Industry: ${c.industry}`);
  if (c.categories?.length) parts.push(`Categories: ${c.categories.join(", ")}`);
  if (c.products?.length) parts.push(`Products: ${c.products.join(", ")}`);
  if (c.productStage) parts.push(`Stage: ${c.productStage}`);
  if (c.trl?.rationale) parts.push(`TRL rationale: ${c.trl.rationale}`);
  if (c.accelerators?.length) parts.push(`Accelerators: ${c.accelerators.join(", ")}`);
  if (c.corporatePartners?.length) {
    parts.push(`Corporate partners: ${c.corporatePartners.map((p) => (p.relationship ? `${p.name} (${p.relationship})` : p.name)).join(", ")}`);
  }
  if (c.patents?.summary) parts.push(`IP summary: ${c.patents.summary}`);
  if (c.patents?.areas?.length) parts.push(`Patent areas: ${c.patents.areas.join(", ")}`);
  const titles = [
    ...(c.patents?.notable ?? []),
    ...(c.patents?.recent ?? []).map((p) => p.title).filter((t): t is string => !!t),
  ];
  if (titles.length) parts.push(`Patent titles: ${[...new Set(titles)].slice(0, 8).join("; ")}`);
  const cpc = c.patents?.cpc ?? [];
  const fmtCpc = (x: CpcCluster) =>
    `${x.code} ${x.label ?? ""}`.trim() + (x.count ? ` ×${x.count}` : "");
  const techCpc = cpc.filter((x) => isTechnologyCpc(x.code));
  const domainCpc = cpc.filter((x) => !isTechnologyCpc(x.code));
  if (techCpc.length) {
    parts.push(`Patent CPC — technology classes (genuine technology-stack hints): ${techCpc.map(fmtCpc).join(", ")}`);
  }
  if (domainCpc.length) {
    parts.push(`Patent CPC — product/domain classes (indicate the field only, NOT the tech stack): ${domainCpc.map(fmtCpc).join(", ")}`);
  }
  if (c.headquarters?.country) parts.push(`HQ country: ${c.headquarters.country}`);
  return parts.join("\n");
}

/** JSON schema for one classification block, enum-constrained to real IDs. */
function blockSchema(ids: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: ["classified", "not_applicable", "needs_review"] },
      // enum guarantees the model can only return real taxonomy IDs. Nullable
      // enums must be expressed as anyOf — a null inside `enum` is rejected.
      primaryId: { anyOf: [{ type: "string", enum: ids }, { type: "null" }] },
      primaryConfidence: { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }] },
      primaryRationale: { type: ["string", "null"] },
      secondary: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            confidence: { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }] },
            rationale: { type: ["string", "null"] },
          },
          required: ["id", "confidence", "rationale"],
        },
      },
    },
    required: ["outcome", "primaryId", "primaryConfidence", "primaryRationale", "secondary"],
  };
}

function termList(nodes: TaxonomyNode[]): string {
  return nodes
    .map((t) => `- ${t.id}: ${t.name}${t.description ? ` — ${t.description}` : ""}${t.parentId ? ` [parent: ${t.parentId}]` : ""}`)
    .join("\n");
}

/** "application_domain" → "Application Domain". */
function dimLabel(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Validate one parsed block against the dimension's nodes and enforce the
 * abstention rules in code, regardless of what the model returned:
 * - outcome != classified → no assignments at all;
 * - low/absent-confidence secondaries are dropped;
 * - a low-confidence primary is discarded and the dimension flagged for review.
 */
function toResult(parsed: DimJson, nodes: TaxonomyNode[]): Omit<DimensionClassification, "dimension"> {
  if (parsed.outcome === "not_applicable") return { notApplicable: true };
  if (parsed.outcome !== "classified") return { needsReview: true };

  const nameById = new Map(nodes.map((t) => [t.id, t.name]));
  const result: Omit<DimensionClassification, "dimension"> = {};
  const primaryConf = conf(parsed.primaryConfidence);
  if (parsed.primaryId && nameById.has(parsed.primaryId) && primaryConf && primaryConf !== "low") {
    result.primary = {
      id: parsed.primaryId,
      name: nameById.get(parsed.primaryId)!,
      confidence: primaryConf,
      ...(parsed.primaryRationale ? { rationale: parsed.primaryRationale } : {}),
    };
  }
  if (!result.primary) return { needsReview: true };
  const secondary = (parsed.secondary ?? [])
    .filter((s) => {
      const c = conf(s.confidence);
      return s.id && nameById.has(s.id) && s.id !== parsed.primaryId && c && c !== "low";
    })
    .map((s) => ({
      id: s.id,
      name: nameById.get(s.id)!,
      confidence: conf(s.confidence)!,
      ...(s.rationale ? { rationale: s.rationale } : {}),
    }));
  if (secondary.length) result.secondary = secondary;
  return result;
}

const GUIDANCE =
  `Assign a term ONLY when the EVIDENCE above explicitly supports it — each rationale must ` +
  `point to the specific evidence (a product, a stated technology, a patent title or area). ` +
  `Never infer a term from sector membership, buzzwords, or plausibility ("a food company ` +
  `might use ML"). Patents are strong evidence — titles and areas document what the company ` +
  `actually built. CPC classes come in two kinds, labelled in the evidence: technology classes ` +
  `(e.g. B33Y additive manufacturing, C12P fermentation, G01N analysis) are genuine ` +
  `technology-stack evidence; product/domain classes (e.g. A23L foods) only say what field ` +
  `the invention is in and are NOT evidence of any technology. ` +
  `Three outcomes per dimension:\n` +
  `- "classified": evidence supports at least one term. Prefer the MOST SPECIFIC term that ` +
  `genuinely fits (a leaf); pick a parent only when no child fits — never assign both a term ` +
  `and its ancestor. If the evidence clearly names a technology but no leaf matches it exactly, ` +
  `assign the nearest parent term that covers it (e.g. evidence of UV spectroscopy with no UV ` +
  `leaf → the spectroscopy parent) rather than abstaining — abstention is for missing evidence, ` +
  `not missing leaves. Secondary terms only for genuine, material cross-cutting fit (usually 0-2). ` +
  `Give a confidence and a one-line rationale for each; use "low" confidence when you are ` +
  `speculating (low-confidence assignments are discarded).\n` +
  `- "not_applicable": the dimension genuinely does not apply — many companies, especially ` +
  `consumer food/CPG brands, have NO distinctive technology stack; if the company does not ` +
  `demonstrably build or operationally rely on a technology as a differentiator, return ` +
  `not_applicable rather than a guess.\n` +
  `- "needs_review": the evidence is too thin to decide either way.\n` +
  `When outcome is not_applicable or needs_review, set primaryId=null and secondary=[] — ` +
  `abstain fully, never return a guess alongside.`;

export async function categorize(
  company: CompanyData,
  taxonomy: TaxonomyNode[],
): Promise<Classification | undefined> {
  if (!taxonomy?.length) return undefined;
  const { anthropicApiKey, classifyModel } = getConfig();
  if (!anthropicApiKey) return undefined;

  const model = classifyModel ?? "claude-sonnet-5";
  const basic = isBasicTier(model);

  // Group nodes by dimension; a flat taxonomy is a single unnamed group.
  const dims = new Map<string, TaxonomyNode[]>();
  for (const t of taxonomy) {
    const key = t.dimension ?? "";
    const list = dims.get(key);
    if (list) list.push(t);
    else dims.set(key, [t]);
  }
  const multi = dims.size > 1 || !dims.has("");
  const dimEntries = [...dims.entries()];
  const flatNodes = dimEntries[0]?.[1] ?? [];

  let schema: Record<string, unknown>;
  let prompt: string;
  if (multi) {
    schema = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        dimEntries.map(([slug, nodes]) => [slug, blockSchema(nodes.map((t) => t.id))]),
      ),
      required: dimEntries.map(([slug]) => slug),
    };
    const sections = dimEntries
      .map(([slug, nodes]) => `## Dimension: ${dimLabel(slug)} (key: ${slug})\n${termList(nodes)}`)
      .join("\n\n");
    prompt =
      `Classify this company against a multi-dimensional taxonomy. The dimensions are ` +
      `orthogonal — classify the company INDEPENDENTLY within each one, using ONLY the ` +
      `given IDs (each dimension's IDs are valid only for that dimension).\n\n` +
      `TAXONOMY:\n${sections}\n\n` +
      `COMPANY EVIDENCE (everything known about the company — judge only from this):\n` +
      `${profileText(company)}\n\n` +
      `For each dimension, decide the outcome and any supported terms. ${GUIDANCE}`;
  } else {
    schema = blockSchema(flatNodes.map((t) => t.id));
    prompt =
      `Classify this company strictly against the taxonomy below. Use ONLY the given IDs.\n\n` +
      `TAXONOMY:\n${termList(flatNodes)}\n\n` +
      `COMPANY EVIDENCE (everything known about the company — judge only from this):\n` +
      `${profileText(company)}\n\n` +
      `Decide the outcome and any supported categories. ${GUIDANCE}`;
  }

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: multi ? 4000 : 2000,
    output_config: basic
      ? { format: { type: "json_schema", schema } }
      : { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  };
  if (!basic) params.thinking = { type: "adaptive" };

  try {
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const response = await client.messages.create(params);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(text);

    if (multi) {
      const dimensions: DimensionClassification[] = dimEntries.map(([slug, nodes]) => ({
        dimension: slug,
        ...toResult(
          parsed[slug] ?? { outcome: "needs_review", primaryId: null, primaryConfidence: null, primaryRationale: null, secondary: [] },
          nodes,
        ),
      }));
      return {
        dimensions,
        needsReview: dimensions.some((d) => d.needsReview),
      };
    }
    return toResult(parsed as DimJson, flatNodes);
  } catch (err) {
    // Classification is best-effort — never fail the enrichment over it. But do
    // surface the cause on stderr so failures aren't silently swallowed.
    console.error(`[categorize] classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
