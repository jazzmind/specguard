import { clientRequestHits } from '../openapi.js';
import type { EndpointExtractor } from '../types.js';

/** `fetch`, `axios`, `ky` and `$http` / `http` calls with a literal URL. */
export const fetchLike: EndpointExtractor = {
  id: 'fetch-like',
  globs: ['**/*.{ts,tsx,js,jsx,mjs,vue,svelte}', '!**/*.{spec,test}.*', '!**/*.d.ts'],
  calls: (source) => clientRequestHits(source),
};
