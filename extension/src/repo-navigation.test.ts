import { it, expect, vi } from 'vitest';
import { repoNavigator } from './repo-navigation.js';
// [claims: capabilities/integration-surfaces#extension-overlay-workspace]
it('previews once, activates on a second same-repo click, and never activates a different row', async () => {
  let time = 0; const preview = vi.fn(); const activate = vi.fn(async () => undefined);
  const click = repoNavigator(preview, activate, () => time);
  await click('/one', 'one'); expect(preview).toHaveBeenCalledWith('/one', 'one'); expect(activate).not.toHaveBeenCalled();
  time = 100; await click('/one', 'one'); expect(activate).toHaveBeenCalledTimes(1);
  time = 200; await click('/two', 'two'); time = 250; await click('/one', 'one'); expect(activate).toHaveBeenCalledTimes(1);
  time = 900; await click('/one', 'one'); expect(activate).toHaveBeenCalledTimes(1);
});
