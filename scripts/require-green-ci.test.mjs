import assert from 'node:assert/strict';
import test from 'node:test';

import { requireGreenCi } from './require-green-ci.mjs';

test('allows a release when CI succeeded for the exact tag commit', async () => {
  const requests = [];
  const logs = [];

  const result = await requireGreenCi('v1.2.3', {
    repository: 'liliu-z/stashbase',
    request: async (path) => {
      requests.push(path);
      if (path === '/repos/liliu-z/stashbase/git/ref/tags/v1.2.3') {
        return { object: { type: 'commit', sha: 'abc123' } };
      }
      if (path === '/repos/liliu-z/stashbase/actions/workflows/ci.yml/runs?head_sha=abc123&event=push&per_page=20') {
        return {
          workflow_runs: [{
            id: 42,
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            event: 'push',
            html_url: 'https://github.example/actions/runs/42',
          }],
        };
      }
      throw new Error(`unexpected request: ${path}`);
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { sha: 'abc123', runId: 42 });
  assert.match(logs.at(-1), /CI gate passed.*abc123.*run 42/i);
  assert.deepEqual(requests, [
    '/repos/liliu-z/stashbase/git/ref/tags/v1.2.3',
    '/repos/liliu-z/stashbase/actions/workflows/ci.yml/runs?head_sha=abc123&event=push&per_page=20',
  ]);
});

test('blocks a release and identifies the failed CI run', async () => {
  const request = async (path) => {
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'commit', sha: 'failed-sha' } };
    }
    return {
      workflow_runs: [{
        id: 43,
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'failed-sha',
        event: 'push',
        html_url: 'https://github.example/actions/runs/43',
      }],
    };
  };

  await assert.rejects(
    requireGreenCi('v1.2.4', { repository: 'liliu-z/stashbase', request }),
    /run 43.*failure/i,
  );
});

test('blocks cancelled and timed-out CI runs', async () => {
  for (const conclusion of ['cancelled', 'timed_out']) {
    const request = async (path) => {
      if (path.includes('/git/ref/tags/')) {
        return { object: { type: 'commit', sha: `${conclusion}-sha` } };
      }
      return {
        workflow_runs: [{
          id: conclusion === 'cancelled' ? 46 : 47,
          status: 'completed',
          conclusion,
          head_sha: `${conclusion}-sha`,
          event: 'push',
        }],
      };
    };

    await assert.rejects(
      requireGreenCi('v1.2.4', { repository: 'liliu-z/stashbase', request }),
      new RegExp(conclusion),
    );
  }
});

test('waits for an in-progress CI run and passes when it succeeds', async () => {
  let runChecks = 0;
  let elapsed = 0;
  const request = async (path) => {
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'commit', sha: 'pending-sha' } };
    }
    runChecks += 1;
    return {
      workflow_runs: [{
        id: 44,
        status: runChecks === 1 ? 'in_progress' : 'completed',
        conclusion: runChecks === 1 ? null : 'success',
        head_sha: 'pending-sha',
        event: 'push',
      }],
    };
  };

  const result = await requireGreenCi('v1.2.5', {
    repository: 'liliu-z/stashbase',
    request,
    pollMs: 10,
    timeoutMs: 30,
    now: () => elapsed,
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    log: () => {},
  });

  assert.deepEqual(result, { sha: 'pending-sha', runId: 44 });
  assert.equal(runChecks, 2);
});

test('peels an annotated release tag to its commit before checking CI', async () => {
  const requests = [];
  const request = async (path) => {
    requests.push(path);
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'tag', sha: 'tag-object-sha' } };
    }
    if (path === '/repos/liliu-z/stashbase/git/tags/tag-object-sha') {
      return { object: { type: 'commit', sha: 'tagged-commit-sha' } };
    }
    return {
      workflow_runs: [{
        id: 45,
        status: 'completed',
        conclusion: 'success',
        head_sha: 'tagged-commit-sha',
        event: 'push',
      }],
    };
  };

  const result = await requireGreenCi('v1.2.6', {
    repository: 'liliu-z/stashbase',
    request,
    log: () => {},
  });

  assert.deepEqual(result, { sha: 'tagged-commit-sha', runId: 45 });
  assert.deepEqual(requests.slice(0, 2), [
    '/repos/liliu-z/stashbase/git/ref/tags/v1.2.6',
    '/repos/liliu-z/stashbase/git/tags/tag-object-sha',
  ]);
});

test('fails closed when no CI run appears before the timeout', async () => {
  let elapsed = 0;
  let runChecks = 0;
  const request = async (path) => {
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'commit', sha: 'missing-sha' } };
    }
    runChecks += 1;
    return { workflow_runs: [] };
  };

  await assert.rejects(
    requireGreenCi('v1.2.7', {
      repository: 'liliu-z/stashbase',
      request,
      pollMs: 10,
      timeoutMs: 20,
      now: () => elapsed,
      sleep: async (milliseconds) => { elapsed += milliseconds; },
      log: () => {},
    }),
    /timed out.*no matching CI run/i,
  );
  assert.equal(runChecks, 3);
});
