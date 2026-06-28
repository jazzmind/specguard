/**
 * Stub handlers for subcommands whose pipelines are not yet implemented.
 *
 * Each prints `"<name>: not yet implemented"` and exits 0 so the command
 * surface and `--help` are complete while pipelines land incrementally.
 */
export function makeStub(name: string): () => Promise<void> {
  return async () => {
    process.stdout.write(`${name}: not yet implemented\n`);
    process.exit(0);
  };
}
