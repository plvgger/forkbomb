/**
 * The product's name, in one place. Rename here and the env names
 * (<SLUG>_API_KEY, <SLUG>_HOSTED_URL, <SLUG>_HOME), the home dir (~/.<slug>),
 * the hosted key prefix and user-facing text follow.
 */
export const BRAND = {
  name: "Forkbomb",
  /** Lowercase [a-z0-9]. Matches the server's BRAND.slug (web/lib/server/config.ts): keys look like "<slug>_sk_…". */
  slug: "forkbomb",
  ticker: "FORKBOMB",
  /** Public site; the hosted API lives under <site>/api/v1. The final domain is not picked yet. */
  site: "https://forkbomb.fun",
} as const;

/**
 * The slug before the rename. Its env names and ~/.<legacy> home are still read,
 * after the new ones, so existing setups keep working; doctor says what to move.
 */
export const LEGACY_SLUG = "forkbomb";

const ENV_PREFIX = BRAND.slug.toUpperCase();
const LEGACY_PREFIX = LEGACY_SLUG.toUpperCase();

/** Env var holding the workspace API key for the hosted engine. */
export const HOSTED_KEY_ENV = `${ENV_PREFIX}_API_KEY`;
/** Env var overriding the hosted API base URL. */
export const HOSTED_URL_ENV = `${ENV_PREFIX}_HOSTED_URL`;
/** Env var overriding where runs, the clone helper and the .env file live. */
export const HOME_ENV = `${ENV_PREFIX}_HOME`;
export const DEFAULT_HOSTED_URL = `${BRAND.site}/api/v1`;

/** Each current env name and the pre-rename name read as its fallback. */
export const LEGACY_ENV: Readonly<Record<string, string>> = {
  [HOSTED_KEY_ENV]: `${LEGACY_PREFIX}_API_KEY`,
  [HOSTED_URL_ENV]: `${LEGACY_PREFIX}_HOSTED_URL`,
  [HOME_ENV]: `${LEGACY_PREFIX}_HOME`,
};

/** A non-blank env value by its current name, else by its pre-rename name. */
export function brandEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const legacy = LEGACY_ENV[name];
  for (const k of legacy ? [name, legacy] : [name]) {
    const v = env[k];
    if (v !== undefined && v.trim()) return v;
  }
  return undefined;
}

/** Pre-rename env names that are set while their new names are not, as "OLD -> NEW" hints. */
export function legacyEnvInUse(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(LEGACY_ENV)
    .filter(([now, old]) => !env[now]?.trim() && env[old]?.trim())
    .map(([now, old]) => `${old} -> ${now}`);
}
