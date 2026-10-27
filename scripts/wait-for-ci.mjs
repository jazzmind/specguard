// Release prerequisite: watch the CI run for the pushed commit, and accept only success.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function waitForCi({ commit, user = 'jazzmind', run = spawnSync, log = console.log }) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit ?? '')) {
    log('A full commit SHA is required to check release CI.');
    return 1;
  }
  const auth = run('gh', ['auth', 'token', '--user', user], { encoding: 'utf8', stdio: 'pipe' });
  if (auth.status !== 0 || !auth.stdout?.trim()) {
    log(`Could not authenticate GitHub CLI as ${user}. Run gh auth login before releasing.`);
    return 1;
  }
  const env = { ...process.env, GH_TOKEN: auth.stdout.trim() };
  const json = (args) => {
    const result = run('gh', args, { env, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) throw new Error('Could not read GitHub CI. Check gh authentication and your connection, then retry.');
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('GitHub CLI returned an unreadable CI result. Retry the release check.');
    }
  };
  try {
    const runs = json(['run', 'list', '--branch', 'main', '--workflow', 'CI', '--commit', commit, '--limit', '1', '--json', 'databaseId,status,conclusion,headSha,url']);
    let ci = Array.isArray(runs) ? runs[0] : undefined;
    if (!ci) {
      log(`No CI run found for ${commit.slice(0, 7)} on main. Push main and retry once CI starts.`);
      return 1;
    }
    if (ci.headSha !== commit || !Number.isSafeInteger(ci.databaseId) || ci.databaseId <= 0) {
      log('GitHub CI did not identify a valid run for this commit. Retry the release check.');
      return 1;
    }
    const url = ci.url || `run ${ci.databaseId}`;
    if (['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(ci.status)) {
      log(`CI is ${ci.status} for ${commit.slice(0, 7)}. Waiting for completion: ${url}`);
      const watched = run('gh', ['run', 'watch', String(ci.databaseId), '--exit-status', '--interval', '10'], { env, stdio: 'inherit' });
      if (watched.status !== 0) {
        log(`CI did not complete successfully, or watching was interrupted: ${url}`);
        return 1;
      }
      // Confirm the final result and commit even when the watcher exits successfully.
      ci = json(['run', 'view', String(ci.databaseId), '--json', 'status,conclusion,headSha']);
    }
    if (ci?.headSha !== commit || ci.status !== 'completed' || ci.conclusion !== 'success') {
      log(`CI has not passed for ${commit.slice(0, 7)} (${ci?.conclusion || ci?.status || 'unknown'}): ${url}`);
      return 1;
    }
    log(`CI passed for ${commit.slice(0, 7)}: ${url}`);
    return 0;
  } catch (error) {
    log(error.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = waitForCi({ commit: process.argv[2], user: process.argv[3] });
}
