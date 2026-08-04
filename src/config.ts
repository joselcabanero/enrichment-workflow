import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader (no dependency). Only sets keys that are not already
 * present in process.env, so real environment variables win over the file.
 */
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return; // no .env file — fine, keys are optional
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export interface Config {
  apolloApiKey?: string;
  openCorporatesToken?: string;
  dealroomApiKey?: string;
  patentsviewApiKey?: string;
  epoConsumerKey?: string;
  epoConsumerSecret?: string;
  anthropicApiKey?: string;
  /** Model for the web-research source; defaults to claude-haiku-4-5. */
  researchModel?: string;
  /** Model for taxonomy classification; defaults to claude-sonnet-5. */
  classifyModel?: string;
  /** Self-consistency votes per classification (1-5); defaults to 3. */
  classifyVotes?: number;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Read credentials from the environment (after .env has been loaded). */
export function getConfig(): Config {
  return {
    apolloApiKey: clean(process.env.APOLLO_API_KEY),
    openCorporatesToken: clean(process.env.OPENCORPORATES_API_TOKEN),
    dealroomApiKey: clean(process.env.DEALROOM_API_KEY),
    patentsviewApiKey: clean(process.env.PATENTSVIEW_API_KEY),
    epoConsumerKey: clean(process.env.EPO_OPS_KEY),
    epoConsumerSecret: clean(process.env.EPO_OPS_SECRET),
    anthropicApiKey: clean(process.env.ANTHROPIC_API_KEY),
    // Cheap by default for DB-scale enrichment; bump to claude-sonnet-5 for
    // more reliable TRL / derived-field accuracy.
    researchModel: clean(process.env.RESEARCH_MODEL) ?? "claude-haiku-4-5",
    // Classification judges a ~400-term taxonomy against sparse evidence —
    // worth a stronger model than the research default.
    classifyModel: clean(process.env.CLASSIFY_MODEL) ?? "claude-sonnet-5",
    // Majority voting across independent classify calls stabilizes borderline
    // assignments across runs. 1 = single call (cheapest).
    classifyVotes: Number(clean(process.env.CLASSIFY_VOTES) ?? "5") || 5,
  };
}
