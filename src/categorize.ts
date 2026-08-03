import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config.js";
import type {
  CategoryAssignment,
  Classification,
  CompanyData,
  TaxonomyNode,
} from "./types.js";

/**
 * Classify a company strictly against the caller's own taxonomy. Returns
 * category assignments carrying the caller's IDs (validated against the
 * supplied nodes) plus confidence, rationale, and a needsReview flag when
 * nothing fits. Never invents categories.
 *
 * Requires ANTHROPIC_API_KEY. Uses RESEARCH_MODEL (default claude-haiku-4-5) —
 * classification is a cheap reasoning task; bump to sonnet-5 for a large or
 * subtle taxonomy.
 */

interface ClassifyJson {
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

export async function categorize(
  company: CompanyData,
  taxonomy: TaxonomyNode[],
): Promise<Classification | undefined> {
  if (!taxonomy?.length) return undefined;
  const { anthropicApiKey, researchModel } = getConfig();
  if (!anthropicApiKey) return undefined;

  const model = researchModel ?? "claude-haiku-4-5";
  const basic = isBasicTier(model);
  const ids = taxonomy.map((t) => t.id);
  const nameById = new Map(taxonomy.map((t) => [t.id, t.name]));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      // enum guarantees the model can only return real taxonomy IDs.
      primaryId: { type: ["string", "null"], enum: [...ids, null] },
      primaryConfidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
      primaryRationale: { type: ["string", "null"] },
      secondary: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            confidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
            rationale: { type: ["string", "null"] },
          },
          required: ["id", "confidence", "rationale"],
        },
      },
      needsReview: { type: "boolean" },
    },
    required: ["primaryId", "primaryConfidence", "primaryRationale", "secondary", "needsReview"],
  } as const;

  const list = taxonomy
    .map((t) => `- ${t.id}: ${t.name}${t.description ? ` — ${t.description}` : ""}${t.parentId ? ` [parent: ${t.parentId}]` : ""}`)
    .join("\n");
  const prompt =
    `Classify this company strictly against the taxonomy below. Use ONLY the given IDs.\n\n` +
    `TAXONOMY:\n${list}\n\n` +
    `COMPANY:\n${profileText(company)}\n\n` +
    `Pick the single best primary category. Add secondary categories only for genuine, ` +
    `material cross-cutting fit (usually 0-2). Give a confidence and a one-line rationale for each. ` +
    `If nothing in the taxonomy fits well, set primaryId=null and needsReview=true rather than forcing a category.`;

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 2000,
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
    const parsed = JSON.parse(text) as ClassifyJson;

    const result: Classification = { needsReview: !!parsed.needsReview };
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
  } catch {
    return undefined;
  }
}
