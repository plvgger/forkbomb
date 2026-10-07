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
  /** Public site; the hosted API lives under <site>/api/v1. */
  site: "https://forkbomb.fun",
} as const;

const ENV_PREFIX = BRAND.slug.toUpperCase();

/** Env var holding the workspace API key for the hosted engine. */
export const HOSTED_KEY_ENV = `${ENV_PREFIX}_API_KEY`;
/** Env var overriding the hosted API base URL. */
export const HOSTED_URL_ENV = `${ENV_PREFIX}_HOSTED_URL`;
/** Env var overriding where runs, the clone helper and the .env file live. */
export const HOME_ENV = `${ENV_PREFIX}_HOME`;
export const DEFAULT_HOSTED_URL = `${BRAND.site}/api/v1`;
