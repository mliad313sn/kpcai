export {
  LAYERS,
  MemoryError,
  isHuman,
  type Fact,
  type Layer,
  type MemoryErrorCode,
  type MemoryProblem,
  type MemoryScope,
  type PendingFact,
  type Provenance,
} from './types.js';
export { encodeValue, decodeValue, formatAttrs, isFactId, parseAttrs } from './attrs.js';
export {
  appendFact,
  emptyDoc,
  factLine,
  factsOf,
  parseMemory,
  serializeMemory,
  type DocLine,
  type MemoryDoc,
} from './format.js';
export { FACT_MAX_CHARS, cleanText, forbiddenMention, screenFact, type Guard } from './guard.js';
export { memoryFile, pendingFile, repoHash } from './files.js';
export {
  MAX_PENDING,
  MemoryStore,
  sameScope,
  type LayerContent,
  type MemoryStoreOptions,
  type ProposalInput,
} from './store.js';
export {
  DEFAULT_MEMORY_TOKENS,
  buildMemoryContext,
  tokensOf,
  type BuildOptions,
  type FactTrust,
  type InjectedFact,
  type MemoryContext,
  type MemoryOrigin,
  type MemorySource,
} from './inject.js';
export {
  MAX_PROPOSALS_PER_NODE,
  MAX_PROPOSAL_CHARS,
  extractProposals,
  withoutProposals,
  type ExtractedProposal,
  type Extraction,
} from './proposals.js';
