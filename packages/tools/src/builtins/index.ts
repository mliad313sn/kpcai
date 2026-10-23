import { browserTools, type BrowserToolOptions } from '../browser/tools.js';
import type { Env } from '../env.js';
import type { LocalTool } from '../types.js';
import { fsTools } from './fs.js';
import { gitTools, type GitToolOptions } from './git.js';
import { shellTool, type ShellToolOptions } from './shell.js';
import { testRunTool, type TestRunToolOptions } from './test-run.js';

export interface BuiltinOptions {
  env?: Env;
  git?: Omit<GitToolOptions, 'env'>;
  shell?: Omit<ShellToolOptions, 'env'>;
  /** `test.run`: configured command, timeouts (R-505). The shell's sandbox is shared. */
  test?: Omit<TestRunToolOptions, 'env'>;
  /** `browser.*`: remote allow-list, artifact folder, zones for `file:` pages. */
  browser?: Omit<BrowserToolOptions, 'env'>;
}

/**
 * fs.list/read/write/delete, git.status/diff/log/apply, shell.run, test.run, browser.* —
 * all jailed to ctx.root (the browser: loopback, workspace files, confirmed origins).
 */
export function builtinTools(options: BuiltinOptions = {}): LocalTool[] {
  const sandbox = options.test?.sandbox ?? options.shell?.sandbox;
  return [
    ...fsTools,
    ...gitTools({ ...options.git, env: options.env }),
    shellTool({ ...options.shell, env: options.env }),
    testRunTool({ ...options.test, ...(sandbox ? { sandbox } : {}), env: options.env }),
    ...browserTools({ ...options.browser, env: options.env }),
  ];
}
