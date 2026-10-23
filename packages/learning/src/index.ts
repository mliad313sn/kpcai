export {
  ACTIONS,
  NOT_ANSWERED,
  PRODUCER_ROLES,
  SAME_PROVIDER_CRITIC_FACTOR,
  SIGNAL_WEIGHTS,
  isTestCommand,
  weightedGrade,
  type Signal,
  type SignalKind,
} from './signals.js';
export { findRun, splitRuns, type JournalRuns, type RunRecord } from './runs.js';
export { baseNode, nodeWork, type NodeWork, type PatchFate, type Verdict } from './work.js';
export {
  gradeJournal,
  gradeRuns,
  readRuns,
  type Grading,
  type IgnoredGrade,
  type IgnoredReason,
  type NodeGrade,
  type ReadOptions,
} from './grades.js';
export {
  CompetenceStore,
  DEFAULT_WINDOW,
  GOOD_GRADE,
  evidencePhrase,
  type CompetenceEntry,
  type CompetenceStoreOptions,
  type SignalCount,
} from './store.js';
export {
  GradeError,
  MAX_AUTHOR_CHARS,
  MAX_NOTE_CHARS,
  localAuthor,
  recordGrade,
  type ManualGradeInput,
  type ManualGradeResult,
} from './manual.js';
export {
  accuracyNote,
  accuracyOf,
  estimateAccuracy,
  type AccuracyOptions,
  type AccuracyReport,
  type AccuracyRow,
  type Basis,
} from './accuracy.js';
export {
  SOURCE_EXTENSIONS,
  excludedPath,
  scanSources,
  symbolsOf,
  type RepoScanOptions,
  type SourceFile,
} from './bench-repo.js';
export {
  MAX_FILE_CHARS,
  benchTasks,
  critiqueTask,
  plantDefect,
  summariseTask,
  unitTestTask,
  type BenchCheck,
  type BenchKind,
  type BenchTask,
  type PlantedDefect,
} from './bench-tasks.js';
export {
  runBench,
  type BenchHost,
  type BenchOptions,
  type BenchPlan,
  type BenchReport,
  type BenchRunResult,
  type BenchTaskResult,
  type CompetenceChange,
} from './bench.js';
