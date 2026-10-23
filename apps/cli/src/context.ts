// Moved to the kernel service layer (ADR-0019); kept here so CLI modules import one place.
export {
  DEFAULT_CONFIRM_ABOVE_USD,
  buildRegistry,
  confirmThreshold,
  journalPath,
  kpaiHome,
  openJournal,
} from '@kernelpai/kernel';
