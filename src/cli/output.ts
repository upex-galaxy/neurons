// Console helpers shared by the CLI modules. All user-facing text is Spanish.

export function out(msg = ''): void {
  process.stdout.write(msg + '\n');
}

export function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

/** An expected failure: main() prints its message (Spanish) without a stack and exits 1. */
export class CliError extends Error {}

export function fail(msg: string): never {
  throw new CliError(msg);
}
