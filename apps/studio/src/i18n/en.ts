/** English: the reference catalogue (every key is defined here first). */
import { enApp } from './en-app';
import { enEnterprise } from './en-enterprise';
import { enLearn } from './en-learn';
import { enReview } from './en-review';
import { enRun } from './en-run';
import { enTools } from './en-tools';
import { enTier } from './en-tier';

export const en = {
  ...enApp,
  ...enRun,
  ...enLearn,
  ...enReview,
  ...enEnterprise,
  ...enTools,
  ...enTier,
} as const;
