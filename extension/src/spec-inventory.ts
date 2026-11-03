/**
 * Counts current spec files. `specs/_archive` holds retired v1 specs and is
 * reported separately so a consolidated repo is counted by its capabilities.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SpecInventory {
  /** Spec files directly in `capabilities/`. */
  capabilities: number;
  /** Every spec file under `capabilities/`, including those in sub-folders (a capability's child specs). */
  capabilityFiles: number;
  hasSystem: boolean;
  livingFiles: number;
  archivedFiles: number;
}

export function inventorySpecs(specsDir: string): SpecInventory {
  const inventory: SpecInventory = { capabilities: 0, capabilityFiles: 0, hasSystem: false, livingFiles: 0, archivedFiles: 0 };
  walk(specsDir, false, false, inventory);
  return inventory;
}

function walk(dir: string, archived: boolean, inCapabilities: boolean, inventory: SpecInventory): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, archived || entry.name === '_archive', inCapabilities || entry.name === 'capabilities', inventory);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
    if (archived) {
      inventory.archivedFiles += 1;
      continue;
    }
    inventory.livingFiles += 1;
    if (entry.name === 'system.md') inventory.hasSystem = true;
    if (inCapabilities) inventory.capabilityFiles += 1;
    if (path.basename(dir) === 'capabilities') inventory.capabilities += 1;
  }
}

export function specCountLabel(inventory: SpecInventory): { specCount: number; specLabel: string } {
  if (inventory.capabilities > 0) {
    const n = inventory.capabilities;
    // Child specs in sub-folders are specs with their own tests, so they count: the same total as coverage and the dashboard.
    const all = inventory.capabilityFiles;
    if (all > n) return { specCount: all, specLabel: `${all} specs (${n} capabilities)` };
    return { specCount: n, specLabel: n === 1 ? '1 capability' : `${n} capabilities` };
  }
  const n = inventory.livingFiles;
  return { specCount: n, specLabel: n === 1 ? '1 spec file' : `${n} spec files` };
}
