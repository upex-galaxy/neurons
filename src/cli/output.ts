// Console helpers shared by the CLI modules. User-facing text comes from src/i18n.

export function out(msg = ''): void {
  process.stdout.write(msg + '\n');
}

export function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

/** An expected failure: main() prints its message (already translated) without a stack and exits 1. */
export class CliError extends Error {}

export function fail(msg: string): never {
  throw new CliError(msg);
}
