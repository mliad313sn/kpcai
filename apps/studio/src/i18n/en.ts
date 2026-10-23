/** English: the reference catalogue (every key is defined here first). */
import { enApp } from './en-app';
import { enLearn } from './en-learn';
import { enReview } from './en-review';
import { enRun } from './en-run';

export const en = { ...enApp, ...enRun, ...enLearn, ...enReview } as const;
