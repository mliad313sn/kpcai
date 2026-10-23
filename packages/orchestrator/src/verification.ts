import type { ContributionRole, ProtocolResult, Verdict } from '@kernelpai/core';
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
  /**
   * Rejecting verdicts answered by a revision, in a node whose final version was approved:
   * one per verdict, however many issues it lists (robust to a verbose critic, P4-F12).
   */
  revisedVerdicts: number;
  /** Distinct major issues (case and spacing ignored) of those verdicts. */
  majorFindings: number;
}

/**
 * Verification ROI of a run (R-404), computed from the run's contributions only:
 * - `reviewUsd` = Σ cost of critic and judge contributions;
 * - `totalUsd` = Σ node costs; `share` = reviewUsd / totalUsd (0 when nothing was spent);
 * - `acceptedFindings` = Σ issues of the rejecting verdicts that were followed by a
 *   revision, counted only on nodes whose final version was approved (a critic, or a
 *   human settling a dispute, accepted the revised work);
 * - `usdPerAcceptedFinding` = reviewUsd / acceptedFindings, null when there is none;
 * - `revisedVerdicts` = the number of those rejecting verdicts (one each, whatever the
 *   number of issues listed); `majorFindings` = their distinct major issues;
 * - `usdPerRevisedVerdict` = reviewUsd / revisedVerdicts, null when there is none. This is
 *   the headline figure: a critic that splits one defect into many issues inflates
 *   `acceptedFindings` but not `revisedVerdicts` (P4-F12).
 */
export interface VerificationRoi {
  reviewUsd: number;
  totalUsd: number;
  share: number;
  issuesRaised: number;
  acceptedFindings: number;
  acceptedRevisions: number;
  usdPerAcceptedFinding: number | null;
  revisedVerdicts: number;
  majorFindings: number;
  usdPerRevisedVerdict: number | null;
  nodes: NodeVerification[];
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Rejecting verdicts since the last draft (author or revision), waiting for a revision. */
class Tally {
  findings = 0;
  verdicts = 0;
  revisions = 0;
  readonly majors = new Set<string>();
  private pending: Verdict[] = [];

  reset(): void {
    this.pending = [];
  }

  reject(v: Verdict): void {
    this.pending.push(v);
  }

  /** A revision answers every pending rejection. */
  revise(): void {
    for (const v of this.pending) {
      this.findings += v.issues.length;
      this.verdicts += 1;
      for (const i of v.issues) {
        if (i.severity === 'major')
          this.majors.add(i.text.trim().replace(/\s+/g, ' ').toLowerCase());
      }
    }
    this.revisions += 1;
    this.pending = [];
  }
}

/** One node's verification figures (see `VerificationRoi` for the formulas). */
export function nodeVerification(res: ProtocolResult): NodeVerification {
  let reviewUsd = 0;
  let raised = 0;
  const t = new Tally();
  for (const c of res.contributions) {
    if (VERIFICATION_ROLES.has(c.role)) reviewUsd += c.costUsd;
    if (c.role === 'author') t.reset();
    if (c.verdict) {
      raised += c.verdict.issues.length;
      if (!accepted(c.verdict)) t.reject(c.verdict);
    }
    if (c.role === 'revision') t.revise();
  }
  const approved = res.ok && res.approved === true;
  return {
    nodeId: res.nodeId,
    reviewUsd: r6(reviewUsd),
    issuesRaised: raised,
    acceptedFindings: approved ? t.findings : 0,
    acceptedRevisions: approved ? t.revisions : 0,
    revisedVerdicts: approved ? t.verdicts : 0,
    majorFindings: approved ? t.majors.size : 0,
  };
}

/** The run's verification ROI over the given results (reused fork nodes left out by the caller). */
export function verificationRoi(results: readonly ProtocolResult[]): VerificationRoi {
  const nodes = results.map(nodeVerification);
  const reviewUsd = r6(nodes.reduce((a, n) => a + n.reviewUsd, 0));
  const totalUsd = r6(results.reduce((a, r) => a + r.costUsd, 0));
  const sum = (k: 'acceptedFindings' | 'revisedVerdicts' | 'majorFindings'): number =>
    nodes.reduce((a, n) => a + n[k], 0);
  const acceptedFindings = sum('acceptedFindings');
  const revisedVerdicts = sum('revisedVerdicts');
  return {
    reviewUsd,
    totalUsd,
    share: totalUsd > 0 ? r6(reviewUsd / totalUsd) : 0,
    issuesRaised: nodes.reduce((a, n) => a + n.issuesRaised, 0),
    acceptedFindings,
    acceptedRevisions: nodes.reduce((a, n) => a + n.acceptedRevisions, 0),
    usdPerAcceptedFinding: acceptedFindings > 0 ? r6(reviewUsd / acceptedFindings) : null,
    revisedVerdicts,
    majorFindings: sum('majorFindings'),
    usdPerRevisedVerdict: revisedVerdicts > 0 ? r6(reviewUsd / revisedVerdicts) : null,
    nodes,
  };
}
