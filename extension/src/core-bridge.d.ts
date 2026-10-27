/** Shared runtime helper bundled from the CLI sources by build.mjs. */
declare module 'specguard-core/activity-ignore' {
  export function ensureActivityLogIgnored(root: string): boolean;
}
