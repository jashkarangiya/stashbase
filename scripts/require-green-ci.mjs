#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const workflowFile = 'ci.yml';

export async function requireGreenCi(tag, options) {
  const {
    repository,
    request,
    log = console.log,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollMs = 15_000,
    timeoutMs = 15 * 60_000,
  } = options;
  if (!tag) throw new Error('release tag is required');
  if (!/^[^/]+\/[^/]+$/.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY must use owner/name format');
  }

  const sha = await resolveTagCommit(tag, repository, request);
  const runsPath = `/repos/${repository}/actions/workflows/${workflowFile}/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=20`;
  const deadline = now() + timeoutMs;

  while (true) {
    const runs = await request(runsPath);
    const matchingRuns = Array.isArray(runs?.workflow_runs)
      ? runs.workflow_runs.filter((run) => run.head_sha === sha && run.event === 'push')
      : [];
    const successfulRun = matchingRuns.find(
      (run) => run.status === 'completed' && run.conclusion === 'success',
    );
    if (successfulRun) {
      log(`[release-ci-gate] CI gate passed for ${tag} (${sha}), run ${successfulRun.id}`);
      return { sha, runId: successfulRun.id };
    }

    const activeRun = matchingRuns.find((run) => run.status !== 'completed');
    const failedRun = matchingRuns.find((run) => run.status === 'completed' && run.conclusion);
    if (!activeRun && failedRun) {
      throw new Error(
        `CI run ${failedRun.id} concluded ${failedRun.conclusion} for release tag ${tag} (${sha})`,
      );
    }

    if (now() >= deadline) {
      const state = activeRun ? `run ${activeRun.id} is ${activeRun.status}` : 'no matching CI run was found';
      throw new Error(`timed out waiting for CI for release tag ${tag} (${sha}): ${state}`);
    }

    const state = activeRun ? `run ${activeRun.id} is ${activeRun.status}` : 'CI run is not available yet';
    log(`[release-ci-gate] Waiting for ${tag} (${sha}): ${state}`);
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

async function resolveTagCommit(tag, repository, request) {
  const ref = await request(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref?.object;

  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === 'commit' && object.sha) return object.sha;
    if (object?.type !== 'tag' || !object.sha) break;
    const tagObject = await request(`/repos/${repository}/git/tags/${encodeURIComponent(object.sha)}`);
    object = tagObject?.object;
  }

  throw new Error(`release tag ${tag} does not resolve to a commit`);
}

async function githubRequest(path) {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'stashbase-release-ci-gate',
      'x-github-api-version': '2026-03-10',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function main() {
  await requireGreenCi(process.argv[2] || process.env.RELEASE_TAG, {
    repository: process.env.GITHUB_REPOSITORY,
    request: githubRequest,
    pollMs: durationFromEnv('STASHBASE_RELEASE_CI_POLL_MS', 15_000),
    timeoutMs: durationFromEnv('STASHBASE_RELEASE_CI_TIMEOUT_MS', 15 * 60_000),
  });
}

function durationFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`[release-ci-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
