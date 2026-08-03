import type { EnrichInput } from "./types.js";
import type { SourceResult } from "./sources/types.js";
import { normalizeDomain } from "./util.js";

export interface ResolvedInput {
  name: string;
  /** Bare host domain, if the caller provided one. */
  domain?: string;
}

/** Validate and normalize the caller's input. Throws on an empty name. */
export function resolveInput(input: EnrichInput): ResolvedInput {
  const name = input.name?.trim();
  if (!name) throw new Error("enrich(): `name` is required and must be non-empty");
  return { name, domain: normalizeDomain(input.domain) };
}

/**
 * Pick a domain from an already-fetched source result (used to feed Apollo when
 * the caller did not supply one). Wikidata's official-website claim is the
 * primary source here.
 */
export function domainFromResult(result: SourceResult | undefined): string | undefined {
  const d = result?.data?.domain;
  return d ? normalizeDomain(d) : undefined;
}
