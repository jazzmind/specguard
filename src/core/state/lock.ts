/**
 * In-process ordering for read-modify-write on one key (a file path, a plan id).
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
const queues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task for `key` has finished, whether they succeeded or failed. */
export async function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.catch(() => undefined));
  return next;
}
