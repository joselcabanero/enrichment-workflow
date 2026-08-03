import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config.js";
import type {
  CategoryAssignment,
  Classification,
  CompanyData,
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
  primaryId: string | null;
  primaryConfidence: string | null;
  primaryRationale: string | null;
  secondary: { id: string; confidence: string | null; rationale: string | null }[];
  needsReview: boolean;
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
  if (c.patents?.cpc?.length) {
    parts.push(`CPC tech areas: ${c.patents.cpc.map((x) => `${x.code} ${x.label ?? ""}`.trim()).join(", ")}`);
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
      needsReview: { type: "boolean" },
    },
    required: ["primaryId", "primaryConfidence", "primaryRationale", "secondary", "needsReview"],
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

/** Validate one parsed block against the dimension's nodes. */
function toResult(parsed: DimJson, nodes: TaxonomyNode[]): Omit<DimensionClassification, "dimension"> {
  const nameById = new Map(nodes.map((t) => [t.id, t.name]));
  const result: Omit<DimensionClassification, "dimension"> = { needsReview: !!parsed.needsReview };
  if (parsed.primaryId && nameById.has(parsed.primaryId)) {
    result.primary = {
      id: parsed.primaryId,
      name: nameById.get(parsed.primaryId)!,
      ...(conf(parsed.primaryConfidence) ? { confidence: conf(parsed.primaryConfidence) } : {}),
      ...(parsed.primaryRationale ? { rationale: parsed.primaryRationale } : {}),
    };
  }
  const secondary = (parsed.secondary ?? [])
    .filter((s) => s.id && nameById.has(s.id) && s.id !== parsed.primaryId)
    .map((s) => ({
      id: s.id,
      name: nameById.get(s.id)!,
      ...(conf(s.confidence) ? { confidence: conf(s.confidence) } : {}),
      ...(s.rationale ? { rationale: s.rationale } : {}),
    }));
  if (secondary.length) result.secondary = secondary;
  if (!result.primary) result.needsReview = true;
  return result;
}

const GUIDANCE =
  `Prefer the MOST SPECIFIC term that genuinely fits (a leaf); pick a parent term only when ` +
  `no child fits well — parents are implied by the hierarchy, never assign both a term and its ` +
  `ancestor. Add secondary terms only for genuine, material cross-cutting fit (usually 0-2). ` +
  `Give a confidence and a one-line rationale for each. If nothing fits well, set ` +
  `primaryId=null and needsReview=true rather than forcing a category.`;

export async function categorize(
  company: CompanyData,
  taxonomy: TaxonomyNode[],
): Promise<Classification | undefined> {
  if (!taxonomy?.length) return undefined;
  const { anthropicApiKey, researchModel } = getConfig();
  if (!anthropicApiKey) return undefined;

  const model = researchModel ?? "claude-haiku-4-5";
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
      `COMPANY:\n${profileText(company)}\n\n` +
      `For each dimension pick the single best primary term. ${GUIDANCE}`;
  } else {
    schema = blockSchema(flatNodes.map((t) => t.id));
    prompt =
      `Classify this company strictly against the taxonomy below. Use ONLY the given IDs.\n\n` +
      `TAXONOMY:\n${termList(flatNodes)}\n\n` +
      `COMPANY:\n${profileText(company)}\n\n` +
      `Pick the single best primary category. ${GUIDANCE}`;
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
        ...toResult(parsed[slug] ?? { needsReview: true }, nodes),
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
