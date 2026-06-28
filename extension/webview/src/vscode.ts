import type { DashboardCommand } from './protocol.js';
interface VsApi { postMessage(msg: DashboardCommand): void; }
declare function acquireVsCodeApi(): VsApi;
export const vscodeApi: VsApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
