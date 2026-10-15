/**
 * `specguard server`: the team server.
 */
import { settingsFromEnv, openBackend, settingsWarnings, type CentralFlags } from '../../server/central/config.js';
import { createPuller } from '../../server/central/puller.js';
import { startCentralServer } from '../../server/central/server.js';

export async function serverCommand(flags: CentralFlags): Promise<void> {
  let settings;
  try {
    settings = settingsFromEnv(process.env, flags);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  for (const warning of settingsWarnings(settings)) process.stderr.write(`warning: ${warning}\n`);
  const backend = await openBackend(settings);
  const server = await startCentralServer({
    backend,
    llm: settings.llm,
    port: settings.port,
    host: settings.host,
    basePath: settings.basePath,
    auth: settings.auth,
  });
  process.stdout.write(`specguard team server (${backend.kind}) listening on ${server.url}\n`);
  // The sandbox cannot receive webhooks, so the server asks GitHub for new CI evidence.
  const puller =
    settings.github.sources.length > 0
      ? createPuller({ sources: settings.github.sources, token: settings.github.token, apiUrl: settings.github.apiUrl, artifact: settings.github.artifact, registry: server.registry, backend, log: (line) => process.stdout.write(`${line}\n`) })
      : undefined;
  puller?.start(settings.github.pollSeconds * 1000);
  if (puller) process.stdout.write(`pulling CI evidence for ${settings.github.sources.map((s) => s.repo).join(', ')} every ${settings.github.pollSeconds}s\n`);
  const stop = (): void => {
    puller?.stop();
    void server.close().then(() => backend.close()).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
