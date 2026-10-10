import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes, releasePlan, versionParts } from './release.mjs';

test('notes include only the requested version, including CRLF files', () => {
  const readme = '# PitchShifter\r\n\r\n## Changelog\r\n\r\n### 1.1.4\r\n\r\n- Restore capture.\r\n\r\n### 1.1.3\r\n\r\n- Previous fix.\r\n\r\n## Features\r\n';
  assert.equal(releaseNotes(readme, '1.1.4'), '- Restore capture.\n');
  assert.throws(() => releaseNotes(readme, '1.1.5'), /missing/);
  assert.throws(() => releaseNotes('## Changelog\n### 1.1.4\n\n## Features', '1.1.4'), /empty/);
});

test('invalid or prerelease versions cannot create stable tags or paths', () => {
  for (const version of ['../file', '1.1.4-beta', '01.1.4', '1.1', '1.1.4\n']) {
    assert.throws(() => versionParts(version));
  }
});

test('repeat runs skip an already published version', () => {
  const release = { tag_name: 'v1.1.4', draft: false };
  assert.equal(releasePlan('1.1.4', [release]).action, 'skip');
});

test('a failed unpublished release can resume', () => {
  assert.equal(releasePlan('1.1.4', [{ tag_name: 'v1.1.4', draft: true }]).action, 'resume');
});

test('an older version cannot replace Latest, including the historical tag format', () => {
  assert.throws(() => releasePlan('1.1.4', [{ tag_name: 'v1.2.0' }]), /increase/);
  assert.throws(() => releasePlan('1.1.0', [{ tag_name: 'v.1.1.0' }]), /increase/);
  assert.equal(releasePlan('1.1.10', [{ tag_name: 'v1.1.9' }]).action, 'create');
  assert.equal(releasePlan('1.1.4', [{ tag_name: 'v2.0.0', draft: true }]).action, 'create');
});

async function withFakeGitHub(uploadFails, check) {
  const directory = await mkdtemp(join(tmpdir(), 'pitchshifter-release-test-'));
  const sha = 'a'.repeat(40);
  const state = { release: null, creates: 0, uploads: 0, publications: 0 };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    response.setHeader('Content-Type', 'application/json');
    const send = (code, body) => { response.statusCode = code; response.end(JSON.stringify(body)); };
    if (request.method === 'GET' && request.url.startsWith('/repos/test/repo/releases?')) {
      return send(200, state.release ? [state.release] : []);
    }
    if (request.method === 'GET' && request.url.includes('/git/ref/tags/')) return send(404, {});
    if (request.method === 'POST' && request.url === '/repos/test/repo/releases') {
      state.creates++;
      state.release = { id: 1, tag_name: 'v1.1.4', draft: true, target_commitish: sha,
        assets: [], upload_url: `http://127.0.0.1:${server.address().port}/upload{?name,label}` };
      return send(201, state.release);
    }
    if (request.method === 'POST' && request.url.startsWith('/upload?')) {
      state.uploads++;
      if (uploadFails) return send(500, { message: 'Simulated upload failure' });
      const asset = { name: 'pitchshifter-1.1.4.zip', state: 'uploaded' };
      state.release.assets.push(asset);
      return send(201, asset);
    }
    if (request.method === 'PATCH' && request.url === '/repos/test/repo/releases/1') {
      state.publications++;
      state.release.draft = false;
      state.release.html_url = 'https://github.com/test/repo/releases/tag/v1.1.4';
      return send(200, state.release);
    }
    return send(500, { message: 'Unexpected test request' });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({ version: '1.1.4', tag: 'v1.1.4', asset: 'pitchshifter-1.1.4.zip', sha }));
    await writeFile(join(directory, 'notes.md'), '- Restore capture.\n');
    await writeFile(join(directory, 'pitchshifter-1.1.4.zip'), 'fixture upload bytes');
    const run = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./release.mjs', import.meta.url)), 'publish'], {
      env: { ...process.env, RELEASE_DIR: directory, GITHUB_REPOSITORY: 'test/repo',
        GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_STEP_SUMMARY: '' },
    });
    await check(run, state);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('publishing uploads before making the release public; repeats do not write', async () => {
  await withFakeGitHub(false, async (run, state) => {
    await run();
    assert.equal(state.release.draft, false);
    await run();
    assert.deepEqual([state.creates, state.uploads, state.publications], [1, 1, 1]);
  });
});

test('an upload failure never publishes an empty release', async () => {
  await withFakeGitHub(true, async (run, state) => {
    await assert.rejects(run(), /Simulated upload failure/);
    assert.equal(state.release.draft, true);
    assert.equal(state.publications, 0);
  });
});
