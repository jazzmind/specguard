/**
 * What an endpoint extractor finds in source: where a client calls an HTTP endpoint and where a service
 * defines one. Extractors are text readers, no parser and no model; a plugin may add its own through
 * `SpecGuardPlugin.endpointExtractors`.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */

/** One place in a file, before the runner attaches the file. */
export interface EndpointHit {
  /** 1-based line. */
  line: number;
  /** Upper-case HTTP method, or null when the code does not say. */
  method: string | null;
  /** The path as written, template holes and parameters kept (`/orders/{}`, `/orders/:id`). */
  path: string;
  /** A call whose base URL is a variable (`cfg.api + '/x'`): the variable's expression. */
  baseKey?: string;
}

/** A client call to an endpoint. `file` is relative to the repo. */
export interface EndpointCall extends EndpointHit {
  file: string;
}

/** A service-side endpoint definition. `file` is relative to the repo. */
export interface EndpointDef extends EndpointHit {
  file: string;
  /** Id of the extractor that found it. */
  source: string;
}

export interface EndpointExtractor {
  id: string;
  /** Globs (relative to the repo) of the files it reads. */
  globs: string[];
  /** Client calls in one file's text. */
  calls?(source: string, file: string): EndpointHit[];
  /** Endpoint definitions in one file's text. */
  defs?(source: string, file: string): EndpointHit[];
}
