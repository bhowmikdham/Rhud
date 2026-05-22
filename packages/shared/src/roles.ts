export const ROLES = [
  'admin',
  'sales_manager',
  'sales_employee',
  'tech_team',
  // Phase C — multi-level approval roles. vp_sales final-approves
  // opportunities above the VP threshold; ceo above the CEO threshold.
  // Both are orthogonal to admin — they don't grant admin powers;
  // they're escalation tiers only.
  'vp_sales',
  'ceo',
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
