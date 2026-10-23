import type { Env } from '../env.js';
import type { LocalTool } from '../types.js';
import { fsTools } from './fs.js';
import { gitTools, type GitToolOptions } from './git.js';
import { shellTool, type ShellToolOptions } from './shell.js';

export interface BuiltinOptions {
  env?: Env;
  git?: Omit<GitToolOptions, 'env'>;
  shell?: Omit<ShellToolOptions, 'env'>;
}

/** fs.list/read/write/delete, git.status/diff/log/apply, shell.run — all jailed to ctx.root. */
export function builtinTools(options: BuiltinOptions = {}): LocalTool[] {
  return [
    ...fsTools,
    ...gitTools({ ...options.git, env: options.env }),
    shellTool({ ...options.shell, env: options.env }),
  ];
}
