import type { ContributionRole, ProtocolResult } from '@kernelpai/core';
import { accepted } from './parse.js';

/** Roles whose calls are verification spend (R-404): critics (retries included) and judges. */
export const VERIFICATION_ROLES: ReadonlySet<ContributionRole> = new Set(['critic', 'judge']);

/** One node's review spend and what it bought. */
export interface NodeVerification {
  nodeId: string;
  /** Spend of critic and judge calls on the node (USD). */
  reviewUsd: number;
  /** Issues in every verdict the node received. */
  issuesRaised: number;
  /** Issues of rejecting verdicts answered by a revision, in a node whose final version was approved. */
  acceptedFindings: number;
  /** Revisions in a node whose final version was approved. */
  acceptedRevisions: number;
}

/**
 * Verification ROI of a run (R-404), computed from the run's contributions only:
 * - `reviewUsd` = Σ cost of critic and judge contributions;
 * - `totalUsd` = Σ node costs; `share` = reviewUsd / totalUsd (0 when nothing was spent);
 * - `acceptedFindings` = Σ issues of the rejecting verdicts that were followed by a
 *   revision, counted only on nodes whose final version was approved (a critic, or a
 *   human settling a dispute, accepted the revised work);
 * - `usdPerAcceptedFinding` = reviewUsd / acceptedFindings, null when there is none.
 */
export interface VerificationRoi {
  reviewUsd: number;
  totalUsd: number;
  share: number;
  issuesRaised: number;
  acceptedFindings: number;
  acceptedRevisions: number;
  usdPerAcceptedFinding: number | null;
  nodes: NodeVerification[];
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** One node's verification figures (see `VerificationRoi` for the formulas). */
export function nodeVerification(res: ProtocolResult): NodeVerification {
  let reviewUsd = 0;
  let raised = 0;
  let findings = 0;
  let revisions = 0;
  // Issues of the rejecting verdicts since the last draft (author or revision).
  let pending = 0;
  for (const c of res.contributions) {
    if (VERIFICATION_ROLES.has(c.role)) reviewUsd += c.costUsd;
    if (c.role === 'author') pending = 0;
    if (c.verdict) {
      raised += c.verdict.issues.length;
      if (!accepted(c.verdict)) pending += c.verdict.issues.length;
    }
    if (c.role === 'revision') {
      findings += pending;
      revisions += 1;
      pending = 0;
    }
  }
  const approved = res.ok && res.approved === true;
  return {
    nodeId: res.nodeId,
    reviewUsd: r6(reviewUsd),
    issuesRaised: raised,
    acceptedFindings: approved ? findings : 0,
    acceptedRevisions: approved ? revisions : 0,
  };
}

/** The run's verification ROI over the given results (reused fork nodes left out by the caller). */
export function verificationRoi(results: readonly ProtocolResult[]): VerificationRoi {
  const nodes = results.map(nodeVerification);
  const reviewUsd = r6(nodes.reduce((a, n) => a + n.reviewUsd, 0));
  const totalUsd = r6(results.reduce((a, r) => a + r.costUsd, 0));
  const acceptedFindings = nodes.reduce((a, n) => a + n.acceptedFindings, 0);
  return {
    reviewUsd,
    totalUsd,
    share: totalUsd > 0 ? r6(reviewUsd / totalUsd) : 0,
    issuesRaised: nodes.reduce((a, n) => a + n.issuesRaised, 0),
    acceptedFindings,
    acceptedRevisions: nodes.reduce((a, n) => a + n.acceptedRevisions, 0),
    usdPerAcceptedFinding: acceptedFindings > 0 ? r6(reviewUsd / acceptedFindings) : null,
    nodes,
  };
}
