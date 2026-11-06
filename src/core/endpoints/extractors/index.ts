import type { EndpointExtractor } from '../types.js';
import { angularHttpClient } from './angular-httpclient.js';
import { express } from './express.js';
import { fetchLike } from './fetch-like.js';
import { jaxrs } from './jaxrs.js';
import { openapi } from './openapi.js';
import { spring } from './spring.js';

/** The extractors that ship with SpecGuard. A plugin adds more through `endpointExtractors`. */
export const BUILTIN_EXTRACTORS: readonly EndpointExtractor[] = [fetchLike, angularHttpClient, spring, jaxrs, express, openapi];

export { angularHttpClient, express, fetchLike, jaxrs, openapi, spring };
