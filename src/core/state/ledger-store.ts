/**
 * The proof ledger behind one interface, so the CLI keeps it in a file and a team server can keep it
 * in a database without the ingest code knowing the difference.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { ExitCode } from '../exit-codes.js';
import { SpecGuardError } from '../errors.js';
import { emptyLedger, type ProofLedger } from '../proof-ledger.js';
import { fileExists, readFile } from '../reader.js';
import { writeFile } from '../writer.js';
import { serially } from './lock.js';

export interface LedgerStore {
  /** Where the ledger lives, for messages. */
  readonly location: string;
  read(): Promise<ProofLedger>;
  /**
   * Read, change and write the ledger as one step. Concurrent updates in this process run one after
   * another, so none is lost. `fn` changes the ledger it is given.
   */
  update<T>(fn: (ledger: ProofLedger) => T | Promise<T>): Promise<T>;
}

/** Highest ledger version this build reads. Newer files are refused rather than read as empty and overwritten. */
export const LEDGER_VERSION = 1;

export interface FileLedgerOptions {
  /** Fix up a ledger just read (for example absolute paths from another machine). Return true when it changed, to have it rewritten. */
  migrate?: (ledger: ProofLedger) => boolean | Promise<boolean>;
}

/** The ledger as a JSON file, written atomically. */
export function fileLedgerStore(file: string, opts: FileLedgerOptions = {}): LedgerStore {
  const read = async (): Promise<ProofLedger> => {
    if (!(await fileExists(file))) return emptyLedger();
    const parsed = JSON.parse(await readFile(file)) as ProofLedger;
    if (!parsed || typeof parsed !== 'object' || !parsed.proofs) return emptyLedger();
    if (parsed.version !== LEDGER_VERSION) {
      throw new SpecGuardError(
        `proof ledger ${file} has version ${String(parsed.version)}; this SpecGuard reads version ${LEDGER_VERSION}. Upgrade SpecGuard rather than overwrite it.`,
        ExitCode.InternalError,
      );
    }
    if (opts.migrate && (await opts.migrate(parsed))) await writeFile(file, JSON.stringify(parsed, null, 2) + '\n');
    return parsed;
  };
  return {
    location: file,
    read,
    update: (fn) =>
      serially(file, async () => {
        const ledger = await read();
        const out = await fn(ledger);
        await writeFile(file, JSON.stringify(ledger, null, 2) + '\n');
        return out;
      }),
  };
}
