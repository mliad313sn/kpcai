/**
 * Why the kernel refused to do something. Each front end maps the code to its own form:
 * the CLI to an exit code and a line on stderr, the server to a JSON-RPC error.
 */
export type KernelErrorCode =
  /** The working directory is not a project (review P2-F10). */
  | 'workspace'
  /** Some nodes cannot be routed as planned. */
  | 'unroutable'
  /** A budget limit or a declined cost confirmation stopped it. */
  | 'budget'
  /** No such plan, run or session. */
  | 'not_found'
  /** Not possible in the current state (applying after a cancel, a run still going…). */
  | 'refused'
  /** The engine does not offer this yet. */
  | 'unsupported'
  /** Inconsistent input (for example a plan id with another request). */
  | 'invalid';

export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}
