/** Français : chaque clé de l'anglais, vérifiée par le compilateur et par un test. */
import type { Catalogue } from './core';
import { frApp } from './fr-app';
import { frLearn } from './fr-learn';
import { frRun } from './fr-run';

export const fr: Catalogue = { ...frApp, ...frRun, ...frLearn };
