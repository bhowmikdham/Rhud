export const ROLES = ['admin', 'sales_manager', 'sales_employee', 'tech_team'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
