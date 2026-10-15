/** The one ApiHub of this extension host, set at activation, so views built in different places can reach it. */
import type { ApiHub } from './hub.js';

let hub: ApiHub | undefined;

export function setHub(next: ApiHub | undefined): void {
  hub = next;
}

export function getHub(): ApiHub | undefined {
  return hub;
}
