/**
 * Sentinel-delimited section engine.
 *
 * Lets SpecGuard own specific regions of an otherwise hand-authored file
 * (CLAUDE.md, AGENTS.md, README.md, …) without clobbering surrounding content:
 *
 *   <!-- specguard:architecture:start -->
 *   ...auto-generated content...
 *   <!-- specguard:architecture:end -->
 *
 * Used by `root-doc-sync.ts` and `scaffold.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SentinelSection {
  sentinel: string;
  content: string;
}

export const SENTINEL_START = (key: string): string => `<!-- specguard:${key}:start -->`;
export const SENTINEL_END = (key: string): string => `<!-- specguard:${key}:end -->`;

/**
 * Replace or insert a sentinel-delimited section in `fileContent`. If the
 * sentinels exist, the content between them is replaced; otherwise a new
 * section is appended at the end.
 */
export function replaceSentinel(
  fileContent: string,
  sentinel: string,
  newContent: string,
): string {
  const start = SENTINEL_START(sentinel);
  const end = SENTINEL_END(sentinel);
  const startIdx = fileContent.indexOf(start);
  const endIdx = fileContent.indexOf(end);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = fileContent.slice(0, startIdx + start.length);
    const after = fileContent.slice(endIdx);
    return `${before}\n${newContent}\n${after}`;
  }

  const sep = fileContent.endsWith('\n') ? '' : '\n';
  return `${fileContent}${sep}\n${start}\n${newContent}\n${end}\n`;
}

/**
 * Apply multiple sentinel sections to a file on disk, creating it (and parent
 * directories) when missing. Existing non-sentinel content is preserved.
 */
export function applyTargetSections(filePath: string, sections: SentinelSection[]): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  for (const { sentinel, content: sectionContent } of sections) {
    content = replaceSentinel(content, sentinel, sectionContent);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
