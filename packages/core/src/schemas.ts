import { z } from 'zod';

/** Kinds of work a task node can represent (spec §3.1). */
export const TaskTypeSchema = z.enum([
  'analysis',
  'code_generation',
  'writing',
  'research',
  'test',
  'critique',
  'decision',
  // Domain types proposed by the packs (D-020, ADR-0024); each has a base type below.
  'reverse_engineering',
  'security_assessment',
  'data_analysis',
  'design',
  'game_design',
  'cad_modelling',
  'geospatial_analysis',
  'creative_writing',
  'translation',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/** The seven types of spec §3.1, which every capability sheet can score. */
export type BaseTaskType =
  'analysis' | 'code_generation' | 'writing' | 'research' | 'test' | 'critique' | 'decision';

/**
 * Base type of each domain type (ADR-0024): a card that does not score a domain type is
 * scored on its base, so routing never breaks when a type is added. Mirrors the packs'
 * `mapsTo`.
 */
export const TASK_TYPE_BASE: Readonly<Record<TaskType, BaseTaskType>> = {
  analysis: 'analysis',
  code_generation: 'code_generation',
  writing: 'writing',
  research: 'research',
  test: 'test',
  critique: 'critique',
  decision: 'decision',
  reverse_engineering: 'analysis',
  security_assessment: 'analysis',
  data_analysis: 'analysis',
  design: 'writing',
  game_design: 'writing',
  cad_modelling: 'code_generation',
  geospatial_analysis: 'analysis',
  creative_writing: 'writing',
  translation: 'code_generation',
};

/**
 * What a task node hands back (D-019, D-020 WI-S1-02, ADR-0022). Mirrors the pack schema's
 * `deliverable` enum; absent means `patch` for code and test nodes, else `answer`. Only
 * `patch` goes through the diff path; the other kinds (but `answer`) are artifacts.
 */
export const DeliverableSchema = z.enum([
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
]);
export type Deliverable = z.infer<typeof DeliverableSchema>;

export const ModalitySchema = z.enum(['text', 'image', 'audio', 'video', 'code']);
export type Modality = z.infer<typeof ModalitySchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * A conversation turn. `assistant` turns may carry the tool calls the model made; each
 * `tool` turn answers one call (phase 2, ADR-0017).
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  /** Tools the model may call; JSON Schema inputs (MCP-compatible). */
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const PriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type Price = z.infer<typeof PriceSchema>;

/** Static capability sheet of one model (spec §3.2). */
export const ModelCardSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  modalities: z.array(ModalitySchema).min(1),
  price: PriceSchema,
  latencyMsTypical: z.number().int().positive().optional(),
  /** Prior competence per task type in [0,1]; overrides strengths/weaknesses when set. */
  competence: z.partialRecord(TaskTypeSchema, z.number().min(0).max(1)).optional(),
  strengths: z.array(TaskTypeSchema).default([]),
  weaknesses: z.array(TaskTypeSchema).default([]),
  notes: z.string().optional(),
});
export type ModelCard = z.infer<typeof ModelCardSchema>;

/** Provider description file (one YAML per provider, spec §3.2). */
export const ProviderDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id, digits and dashes'),
  name: z.string().min(1),
  kind: z.enum(['cloud', 'local', 'aggregator', 'test']),
  adapter: z.string().min(1),
  baseUrl: z.url().optional(),
  baseUrlEnv: z.string().optional(),
  auth: z
    .object({
      // Only credential-shaped names, so a shared descriptor cannot exfiltrate arbitrary
      // environment variables such as AWS_SECRET_ACCESS_KEY (review F8).
      env: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*_API_(KEY|TOKEN)$/, 'must look like <PROVIDER>_API_KEY'),
    })
    .optional(),
  jurisdiction: z.string().min(1),
  retention: z.string().min(1),
  discoverModels: z.boolean().default(false),
  defaultLocalCard: ModelCardSchema.omit({ id: true }).partial().optional(),
  models: z.array(ModelCardSchema).default([]),
});
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'cancelled' | 'tool_use' | 'other';

/** Normalised streaming events every adapter emits. */
export type StreamEvent =
  | { type: 'start'; requestId: string; model: string }
  | { type: 'text'; delta: string }
  | { type: 'usage'; usage: Usage }
  /** The provider is working without visible text yet (reasoning, step start). Keeps stall timers alive. */
  | { type: 'progress'; kind: 'reasoning' | 'step' }
  /** A complete tool call (input fully received and parsed). */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'end'; stopReason: StopReason };
