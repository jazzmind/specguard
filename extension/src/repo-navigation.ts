/** Previewing must not change the active project; a second click on the same row activates it. */
export function repoNavigator(preview: (root: string, key: string) => void, activate: (root: string, key: string) => PromiseLike<unknown>, now = Date.now) {
  let previous: { root: string; time: number } | undefined;
  return async (root: string, key: string) => {
    const time = now();
    if (previous?.root === root && time - previous.time < 500) {
      previous = undefined;
      await activate(root, key);
    } else {
      previous = { root, time };
      preview(root, key);
    }
  };
}
