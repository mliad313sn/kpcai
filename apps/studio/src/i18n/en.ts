/** English: the reference catalogue (every key is defined here first). */
import { enApp } from './en-app';
import { enRun } from './en-run';

export const en = { ...enApp, ...enRun } as const;
