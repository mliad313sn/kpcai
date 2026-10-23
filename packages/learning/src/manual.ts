/**
 * Manual grades (`kpai grade <run> <node> good|bad [note]`, ADR-0028): journaled as an
 * `intervention` with the human author, in the graded run's session. Only the kernel
 * appends interventions (a model's tool calls are journaled as `tool` events), so a model
 * cannot slip a grade in; a grade whose author names the graded model is ignored.
 */
import { userInfo } from 'node:os';
import { refToString, type ModelRef } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';
import { readRuns, type ReadOptions } from './grades.js';
import { findRun } from './runs.js';
import { ACTIONS } from './signals.js';
import { nodeWork } from './work.js';

export const MAX_NOTE_CHARS = 500;
export const MAX_AUTHOR_CHARS = 100;

export class GradeError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'GradeError';
  }
}

export interface ManualGradeInput {
  /** Run id (or ≥ 6-character prefix), or a session id for a run without one. */
  run: string;
  nodeId: string;
  grade: 'good' | 'bad';
  /** Who grades: a person, never a model. */
  author: string;
  note?: string;
}

export interface ManualGradeResult {
  runKey: string;
  nodeId: string;
  /** The model whose work was graded. */
  ref: ModelRef;
  taskType?: string;
  event: JournalEvent;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const clean = (s: string, max: number): string => s.replace(CONTROL, ' ').trim().slice(0, max);

/** The local user's name, the default author of a manual grade. */
export function localAuthor(): string {
  try {
    return userInfo().username || 'user';
  } catch {
    return 'user';
  }
}

/**
 * Journals a manual grade of one node. Throws `GradeError` when the run or node is
 * unknown, the node has no output to grade, or the input is invalid.
 */
export function recordGrade(
  journal: Journal,
  input: ManualGradeInput,
  options: ReadOptions = {},
): ManualGradeResult {
  if (input.grade !== 'good' && input.grade !== 'bad') {
    throw new GradeError('invalid', 'a grade is "good" or "bad"');
  }
  const author = clean(input.author ?? '', MAX_AUTHOR_CHARS);
  if (!author) throw new GradeError('invalid', 'a manual grade needs its author');
  const runs = readRuns(journal, options);
  const run = findRun(runs, input.run.trim());
  if (!run)
    throw new GradeError('not_found', `no run ${clean(input.run, 80)} (or ambiguous prefix)`);
  const w = nodeWork(run).get(input.nodeId);
  if (!w?.producer) {
    throw new GradeError(
      'not_found',
      `run ${run.key} has no answered node ${clean(input.nodeId, 80)}`,
    );
  }
  if (author.toLowerCase() === refToString(w.producer).toLowerCase()) {
    throw new GradeError('invalid', 'a model cannot grade its own work');
  }
  const note = input.note ? clean(input.note, MAX_NOTE_CHARS) : undefined;
  const event = journal.append({
    sessionId: run.sessionId,
    type: 'intervention',
    nodeId: input.nodeId,
    payload: {
      action: ACTIONS.grade,
      runId: run.key,
      nodeId: input.nodeId,
      grade: input.grade,
      author,
      source: 'human',
      graded: refToString(w.producer),
      ...(note ? { note } : {}),
    },
  });
  return {
    runKey: run.key,
    nodeId: input.nodeId,
    ref: w.producer,
    ...(w.taskType ? { taskType: w.taskType } : {}),
    event,
  };
}
