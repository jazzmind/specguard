import type { AppCoverage, CoverageItem } from './protocol.js';

/** Lenient parser for the text output of `specguard status` (no --json yet). */
export function parseCoverageText(raw: string): AppCoverage[] {
  const apps: AppCoverage[] = [];
  const appSections = raw.split(/^# /m).filter(Boolean);

  for (const section of appSections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const nameMatch = header.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const items: CoverageItem[] = [];
    for (const line of lines.slice(1)) {
      const noTestMatch = line.match(/^\s+\[ok\]\s+(\S+)\s+\(no test\)/);
      const okMatch = line.match(/^\s+\[ok\]\s+(\S+)/);
      const missingMatch = line.match(/^\s+\[missing-spec\]\s+(\S+)/);
      if (noTestMatch) items.push({ app: name, key: noTestMatch[1], hasSpec: true, hasTest: false });
      else if (okMatch) items.push({ app: name, key: okMatch[1], hasSpec: true, hasTest: true });
      else if (missingMatch) items.push({ app: name, key: missingMatch[1], hasSpec: false, hasTest: false });
    }

    const summary = section.match(/(\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests/);
    const sourceCount = summary ? parseInt(summary[1], 10) : items.length;
    const specCount = summary ? parseInt(summary[2], 10) : items.filter((i) => i.hasSpec).length;
    const percentage = summary ? parseInt(summary[3], 10) : 0;
    apps.push({ name, specCount, sourceCount, testCount: 0, percentage, items });
  }
  return apps;
}
