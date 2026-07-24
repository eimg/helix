/**
 * Fixed inception specialist roles. Like PR control's reviewer/verifier,
 * these names are the product contract — Manage may edit prompts, not invent
 * new role names. Optional config may reorder them.
 */
export const INCEPTION_ROLES = ["architect", "scaffolder", "validator"] as const;

export type InceptionRole = (typeof INCEPTION_ROLES)[number];

export const DEFAULT_INCEPTION_ROLES: InceptionRole[] = [...INCEPTION_ROLES];

export function isInceptionRole(name: string): name is InceptionRole {
  return (INCEPTION_ROLES as readonly string[]).includes(name);
}

/**
 * Validate an optional config role order. Must list every fixed role exactly once.
 */
export function normalizeInceptionRoles(raw: unknown): InceptionRole[] {
  if (raw === undefined || raw === null) return [...DEFAULT_INCEPTION_ROLES];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("config: inception.roles must be a non-empty array of role names");
  }
  const roles = raw.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("config: inception.roles entries must be non-empty strings");
    }
    return item.trim();
  });
  const unique = new Set(roles);
  if (unique.size !== roles.length) {
    throw new Error("config: inception.roles must list each role at most once");
  }
  for (const role of INCEPTION_ROLES) {
    if (!unique.has(role)) {
      throw new Error(`config: inception.roles missing required role "${role}"`);
    }
  }
  for (const role of roles) {
    if (!isInceptionRole(role)) {
      throw new Error(
        `config: inception.roles unknown role "${role}" (expected ${INCEPTION_ROLES.join(", ")})`,
      );
    }
  }
  return roles as InceptionRole[];
}
