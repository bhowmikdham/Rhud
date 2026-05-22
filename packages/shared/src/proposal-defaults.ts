// Phase D — tenant-wide proposal defaults the DOCX renderer interpolates.
//
// Stored in `tenants.proposal_defaults` JSONB. Shape is loose enough
// that adding a new section later doesn't require a migration; field
// names below are the ones the renderer looks up.

/** Per-category boilerplate keyed by category slug
 *  (matches OpportunityCategory.slug from Phase B). */
export interface ProposalDefaults {
  /** Methodology blurb per category. Example:
   *  { vapt: "We follow OWASP WSTG ...", grc: "Our GRC methodology ..." } */
  methodologyByCategory?: Record<string, string>;
  /** Tools / technologies list per category. */
  toolsByCategory?: Record<string, string>;
  /** Generic "About our team" block — same for every proposal. */
  teamDetails?: string;
  /** Tenant-wide terms & conditions. Appended verbatim to the proposal. */
  termsConditions?: string;
  /** Optional cover-page tagline. Falls back to "Proposal for {client}". */
  coverTagline?: string;
}
