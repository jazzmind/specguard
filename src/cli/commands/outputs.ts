import { describeOutputs, outputKinds, saveOutputLocation, type OutputKind } from '../../core/output-locations.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export async function outputsCommand(opts: GlobalOpts & { app?: string; kind?: string; directory?: string }): Promise<void> {
  const config = await loadCliConfig(opts);
  if (opts.directory) {
    if (!opts.app || !outputKinds.includes(opts.kind as OutputKind)) throw new Error('Saving a destination requires --app and --kind');
    saveOutputLocation(config, opts.app, opts.kind as OutputKind, opts.directory);
  }
  const data = describeOutputs(config).filter(a => !opts.app || a.app === opts.app);
  if (opts.app && !data.length) throw new Error(`Unknown application: ${opts.app}`);
  console.log(opts.json ? JSON.stringify(data) : data.map(a => `${a.app}\nCode: ${a.code}\n${a.outputs.map(o => `  ${o.kind}: ${o.directory}${o.mappingOnly ? ' (mapping directory; choose executable test output)' : ''}`).join('\n')}`).join('\n'));
}
