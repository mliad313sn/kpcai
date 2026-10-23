import { ProtocolNameSchema, TaskTypeSchema } from './core-types.js';
import { z } from 'zod';

/** Pack ids are file names and journal keys: lower-case words joined by `-`. */
export const PackIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, {
  message: 'pack id: lower-case letters, digits and single dashes, starting with a letter',
});

const Text = z.string().min(1).max(600);
const Short = z.string().min(1).max(120);
const Glob = z
  .string()
  .min(1)
  .max(200)
  .refine((g) => !g.includes('\0') && !g.split('/').includes('..'), 'glob may not contain ".."');

/**
 * A file or folder that shows a folder is a real workspace for this profile. `optIn`
 * markers (single binaries, firmware dumps) only count after the user agrees, because
 * a lone binary is also what a downloads folder looks like. `weak` markers (a README,
 * any Markdown file) still accept a workspace but count little when packs are ranked,
 * so a generic file never outranks the files that really say what a folder is for.
 */
export const MarkerSchema = z
  .object({
    glob: Glob,
    optIn: z.boolean().default(false),
    weak: z.boolean().default(false),
    why: Short.optional(),
  })
  .strict();

const NodeHintSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    title: Short,
    /** An existing task type of packages/core (validated against its enum). */
    type: TaskTypeSchema,
    protocol: ProtocolNameSchema,
    dependsOn: z.array(z.string()).max(16).default([]),
    /** Tool names the node may use; suggestions for the planner, still under the policy. */
    tools: z
      .array(z.string().regex(/^[a-zA-Z0-9_.*-]{1,64}$/))
      .max(32)
      .default([]),
    /** What the node hands back. Only `patch` goes through the patch/apply path today. */
    deliverable: z
      .enum([
        'answer',
        'report',
        'patch',
        'notebook',
        'design',
        'build',
        'checklist',
        'model3d',
        'map',
        'config',
        'asset',
      ])
      .default('answer'),
    instruction: Text.optional(),
  })
  .strict();

/** A node sequence that suits the profile, used when one of `when` appears in a request. */
export const PlanHintSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    title: Short,
    when: z.array(z.string().min(2).max(60)).min(1).max(40),
    nodes: z.array(NodeHintSchema).min(1).max(12),
  })
  .strict();

/** Task types this profile needs that packages/core does not have yet (work item for S1). */
export const ProposedTaskTypeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    description: Text,
    /** The existing type used until core has the new one. */
    mapsTo: TaskTypeSchema,
  })
  .strict();

export const ToolSuggestionSchema = z
  .object({
    name: Short,
    kind: z.enum(['mcp', 'cli', 'app', 'library']),
    purpose: Text,
    url: z.url({ protocol: /^https$/ }).optional(),
    /** false = not checked against a primary source (shown as [U]). */
    verified: z.boolean().default(false),
  })
  .strict();

export const ZoneRelaxSchema = z
  .object({
    /** Paths matching this glob are exempt from the heuristic default zones only. */
    allow: Glob,
    reason: Text,
  })
  .strict();

export const ZonesSchema = z
  .object({
    add: z.array(Glob).max(100).default([]),
    relax: z.array(ZoneRelaxSchema).max(20).default([]),
  })
  .strict();

export const ScopeKindSchema = z.enum(['host', 'network', 'url', 'binary', 'repository', 'other']);

export const SafetySchema = z
  .object({
    /** Work needs a declared, unexpired authorised scope before any node runs. */
    requiresScope: z.boolean().default(false),
    scopeKinds: z.array(ScopeKindSchema).max(6).default([]),
    /** Prefer local models (sensitive inputs: samples, client data, unreleased work). */
    preferLocal: z.boolean().default(false),
    /**
     * Work can move or switch physical things (locks, heating, printers, motors): every
     * actuating call needs a confirmation and a dry run or simulation first.
     */
    physicalEffects: z.boolean().default(false),
    /** Inputs may hold personal data (locations, health, clients): keep them local. */
    personalData: z.boolean().default(false),
    /** Plain-language limits shown with the plan. */
    limits: z.array(Text).max(12).default([]),
  })
  .strict();

export const GlossaryEntrySchema = z.object({ term: Short, meaning: Text }).strict();

export const PackSchema = z
  .object({
    id: PackIdSchema,
    version: z.number().int().min(1).max(1000).default(1),
    name: Short,
    description: Text,
    profiles: z.array(Short).min(1).max(12),
    markers: z.array(MarkerSchema).max(60).default([]),
    plans: z.array(PlanHintSchema).max(12).default([]),
    proposedTaskTypes: z.array(ProposedTaskTypeSchema).max(12).default([]),
    /** Extra review criteria for critics on this profile's nodes (work item for S4). */
    reviewCriteria: z.array(Text).max(16).default([]),
    tools: z.array(ToolSuggestionSchema).max(30).default([]),
    zones: ZonesSchema.default({ add: [], relax: [] }),
    safety: SafetySchema.default({
      requiresScope: false,
      scopeKinds: [],
      preferLocal: false,
      physicalEffects: false,
      personalData: false,
      limits: [],
    }),
    glossary: z.array(GlossaryEntrySchema).max(40).default([]),
    tips: z.array(Text).max(12).default([]),
  })
  .strict();

export type Marker = z.infer<typeof MarkerSchema>;
export type PlanHint = z.infer<typeof PlanHintSchema>;
export type NodeHint = z.infer<typeof NodeHintSchema>;
export type ZoneRelax = z.infer<typeof ZoneRelaxSchema>;
export type Pack = z.infer<typeof PackSchema>;
export type ScopeKind = z.infer<typeof ScopeKindSchema>;
