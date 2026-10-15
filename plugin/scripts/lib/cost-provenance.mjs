export const COST_PROVENANCES = ["vendor", "estimated", "modeled", "none"];

/**
 * Which provenance total an event's cost belongs in, or undefined when the
 * event carries no known label. A seat adapter's estimate is priced from
 * token counts and never billed, so it counts as modeled. costCap.ts applies
 * the same rule to the cap's modeled share.
 */
export function costProvenance(e) {
  if (e?.adapter_provenance === "modeled") return "modeled";
  return COST_PROVENANCES.includes(e?.provenance) ? e.provenance : undefined;
}
