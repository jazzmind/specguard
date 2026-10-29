import * as fs from 'fs';
/** Read existing dotenv credentials for compatibility. New editor credentials use SecretStorage. */
export function loadDotEnv(filePath: string): Record<string, string> {
  try {
    const vars: Record<string, string> = {};
    for (const raw of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0) {
        const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (value !== 'your-key-here') vars[line.slice(0, eq).trim()] = value;
      }
    }
    return vars;
  } catch { return {}; }
}
