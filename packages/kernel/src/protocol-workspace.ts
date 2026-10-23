/**
 * Protocol additions for checkpoints, run worktrees, repository rules and artifacts
 * (ADR-0021, ADR-0022; version 1, additive). Merged into `Methods` by protocol.ts.
 */
import { z } from 'zod';

const Id = z.string().min(1).max(100);
const Ref = z.object({ provider: z.string(), model: z.string() });
const RepoPath = z.string().min(1).max(512);

/** Rule files given to every node as UNTRUSTED context (R-306): names, never content. */
export const RulesSchema = z.looseObject({
  trust: z.literal('untrusted'),
  files: z.array(
    z.looseObject({
      path: z.string(),
      kind: z.string(),
      scope: z.string(),
      applies: z.boolean(),
      bytes: z.number(),
      truncated: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
  omitted: z.array(z.string()),
  skippedForbidden: z.number().int(),
});

const Relaxation = z.looseObject({ pack: z.string(), allow: z.string(), reason: z.string() });

/** Domain packs chosen for the workspace, why, and the zones in force with origin (D-020). */
export const PacksSchema = z.looseObject({
  packs: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      reason: z.string(),
      evidence: z.array(z.string()),
      requiresScope: z.boolean(),
      preferLocal: z.boolean(),
      physicalEffects: z.boolean(),
      personalData: z.boolean(),
      limits: z.array(z.string()),
    }),
  ),
  /** Every forbidden zone in force: glob, tier (credential, heuristic, added) and origin. */
  zones: z.array(z.looseObject({ glob: z.string(), tier: z.string(), origin: z.string() })),
  /** Pack relaxations in force (user-approved, heuristic tier only). */
  relaxed: z.array(Relaxation),
  /** Pack relaxations waiting for approval: asked at run start, never applied before. */
  pending: z.array(Relaxation),
  /** Pack relaxations refused outright, with the reason. */
  refused: z.array(z.looseObject({ pack: z.string(), allow: z.string(), problem: z.string() })),
  /** One line per pack zone change, for display. */
  lines: z.array(z.string()),
  problems: z.array(z.string()),
});

/** The authorised scope selected packs need (WI-S1-03): refused while `problems` is not empty. */
export const ScopeStatusSchema = z.looseObject({
  required: z.array(z.string()),
  source: z.enum(['request', 'file']).optional(),
  lines: z.array(z.string()),
  problems: z.array(z.string()),
});

/** An authorised scope as the user declares it (validated in full by the kernel). */
export const AuthorisedScopeInputSchema = z.looseObject({
  targets: z
    .array(z.object({ kind: z.string().max(20), value: z.string().max(300) }))
    .min(1)
    .max(200),
  engagementRef: z.string().max(200),
  authorisedBy: z.string().max(200),
  expires: z.string().max(40),
  notes: z.string().max(1000).optional(),
});

export const CheckpointSchema = z.looseObject({
  ref: z.string(),
  runId: z.string(),
  n: z.number().int(),
  label: z.string(),
  createdAt: z.string(),
  commit: z.string(),
  where: z.enum(['workspace', 'worktree']),
});

/** Same kinds as the pack schema's `deliverable` enum, minus `answer` and `patch`. */
export const ArtifactKindSchema = z.enum([
  'report',
  'notebook',
  'design',
  'build',
  'checklist',
  'model3d',
  'map',
  'config',
  'asset',
]);

/** A non-code output of an approved node (D-019, ADR-0022), with its provenance. */
export const ArtifactSchema = z.looseObject({
  nodeId: Id,
  path: RepoPath,
  kind: ArtifactKindSchema,
  mime: z.string().max(200),
  content: z.string(),
  bytes: z.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** False: a document no critic reviewed; saved only on its own confirmation (D-020). */
  reviewed: z.boolean(),
  provenance: z.looseObject({
    runId: Id,
    sessionId: Id,
    nodeId: Id,
    author: Ref.optional(),
    reviewer: Ref.optional(),
  }),
});

const RunSummarySchema = z.looseObject({
  runId: Id,
  planId: Id,
  sessionId: Id,
  request: z.string(),
  state: z.enum(['starting', 'running', 'paused', 'cancelling', 'done', 'failed', 'cancelled']),
  startedAt: z.string(),
  costUsd: z.number(),
  isolated: z.boolean(),
  worktree: z.string().optional(),
  diff: z
    .object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() })
    .optional(),
  verdict: z.enum(['approved', 'changes_requested']).optional(),
  patches: z.number().int(),
  artifacts: z.number().int(),
});

const RunRef = z.object({ runId: Id });
const CheckpointRef = z.string().min(1).max(200);

export const WorkspaceMethods = {
  /** Checkpoints of a run, workspace ones then worktree ones, oldest first (R-305). */
  'run.checkpoints': {
    params: RunRef,
    result: z.object({ checkpoints: z.array(CheckpointSchema) }),
  },
  /**
   * Restores a checkpoint of the run (R-305). Destructive: a `confirm.request` of kind
   * `restore` is sent; no answer before its timeout is a no (`restored: false`).
   */
  'run.restore': {
    params: z.object({ runId: Id, ref: CheckpointRef }),
    result: z.union([
      z.object({
        restored: z.literal(true),
        written: z.array(z.string()),
        deleted: z.array(z.string()),
        skipped: z.number().int(),
        /** Checkpoint of the tree just before this restore, to undo it. */
        undo: z.string(),
      }),
      z.object({ restored: z.literal(false), reason: z.string() }),
    ]),
  },
  /** Merges an isolated run's worktree into the workspace: a confirmed write (R-307). */
  'run.merge': {
    params: RunRef,
    result: z.object({
      merged: z.boolean(),
      files: z.array(z.string()),
      omitted: z.number().int(),
      /** Workspace checkpoint taken just before the merge. */
      checkpoint: z.string().optional(),
      reason: z.string().optional(),
    }),
  },
  /** Removes an isolated run's worktree; its checkpoints are kept (R-307). */
  'run.discard': { params: RunRef, result: z.object({ removed: z.boolean() }) },
  /** The runs manager view (R-307). */
  'runs.list': {
    params: z.object({}).optional(),
    result: z.object({ runs: z.array(RunSummarySchema) }),
  },
  /** Writes approved artifacts of a finished run, each confirmed with its content (D-019). */
  'artifacts.apply': {
    params: z.object({ runId: Id, paths: z.array(RepoPath).max(200).optional() }),
    result: z.object({
      results: z.array(
        z.object({ path: z.string(), nodeId: Id, ok: z.boolean(), message: z.string() }),
      ),
    }),
  },
} as const;
