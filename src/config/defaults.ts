/**
 * Shared Helix defaults (not project config).
 *
 * Essentials (API key, model) live in `.helix/.env` or fall back to the
 * operator's global pi install — not in `.helix/config.json`. Repo-root
 * `.env` is for the application.
 */

/**
 * Helix default HTTP port: **8319** — phone-keypad spelling of "helix"
 * (8 = H, 3 = E, 1 = L, 9 = IX).
 */
export const HELIX_DEFAULT_PORT = 8319;

/** Env var name for the OpenRouter API key. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * Shipped default model when `HELIX_MODEL` is unset.
 * Matches `helix init`'s `.helix/.env.example`.
 */
export const HELIX_DEFAULT_MODEL = "openrouter/xiaomi/mimo-v2.5-pro";
