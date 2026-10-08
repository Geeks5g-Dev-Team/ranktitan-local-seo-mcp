/**
 * The shapes tools work with.
 *
 * Deliberately narrower than what the backend returns: a field has to be added
 * here on purpose before it can reach a model, which keeps tokens, owner emails
 * and raw GMB payloads from leaking into a chat because an endpoint grew.
 */

export interface BusinessSummary {
  locationId: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  active: boolean;
  planType: string | null;
  /** The slice of the stored GMB payload the audit tool reads. */
  gmb: GmbSnapshot;
}

export interface KeywordRanking {
  keyword: string;
  /** Lower is better: 1 means the business shows first across the grid. */
  score: number | null;
  /** Raw backend status: ranked, pending, failed… */
  status: string;
  /** False when the keyword was never actually measured, whatever the score says. */
  measured: boolean;
  /**
   * When this measurement was taken, ISO, or null if the backend did not say.
   *
   * Carried because a stored position presented without its date reads as
   * current. These can be weeks old, and "you rank 3rd" is a different claim
   * from "you ranked 3rd a month ago".
   */
  measuredAt: string | null;
}

export interface PendingReview {
  reviewId: string;
  author: string | null;
  rating: number | null;
  comment: string | null;
  createdAt: string | null;
  /** Link to the review on Google, so a reply can be checked afterwards. */
  url: string | null;
}

/** One checked field of a Google Business Profile. */
export interface ProfileCheck {
  label: string;
  passed: boolean;
  /** What was found, or what is missing. Shown verbatim in the chat. */
  detail: string;
}

export interface ProfileAudit {
  checks: ProfileCheck[];
  passed: number;
}

/**
 * The slice of the stored GMB payload the audit reads.
 *
 * Field names verified against a real record rather than assumed: the profile
 * description lives under `profile.description`, the phone under
 * `phoneNumbers.primaryPhone`, and `regularHours` is simply absent when hours
 * were never set — which is itself a finding.
 */
export interface GmbSnapshot {
  description: string | null;
  primaryCategory: string | null;
  additionalCategories: number;
  websiteUri: string | null;
  primaryPhone: string | null;
  hasHours: boolean;
  hasGeometry: boolean;
  mapsUri: string | null;
}

/** A business as Google shows it publicly. No Rank Titan account involved. */
export interface PublicBusiness {
  placeId: string;
  name: string;
  address: string | null;
  primaryCategory: string | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number;
  hasHours: boolean;
  status: string | null;
  mapsUri: string | null;
}

export interface PublicCompetitor {
  placeId: string;
  name: string;
  address: string | null;
  rating: number | null;
  reviewCount: number;
}

/** A rival the grid found. */
export interface HeatmapCompetitor {
  name: string;
  score: number | null;
  reviews: number | null;
  rating: number | null;
}

/** A ranking grid, running or finished. */
export interface HeatmapScan {
  state: "pending" | "completed";
  reportId: string;
  /** Public page that renders the map. No account needed to open it. */
  reportUrl: string;
  keyword: string | null;
  businessName: string | null;
  /** Average position across the grid. Lower is better. */
  averageRank: number | null;
  gridPoints: number;
  highRelevance: number;
  mediumRelevance: number;
  lowRelevance: number;
  competitors: HeatmapCompetitor[];
}
