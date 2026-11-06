import { parseOpenApi } from '../openapi.js';
import type { EndpointExtractor } from '../types.js';

/** Operations of an OpenAPI or Swagger document. */
export const openapi: EndpointExtractor = {
  id: 'openapi',
  globs: ['**/{openapi,swagger}.{json,yaml,yml}'],
  defs: (source) => parseOpenApi(source).map((op) => ({ line: 1, method: op.method, path: op.path })),
};
