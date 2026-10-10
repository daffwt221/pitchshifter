import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function versionParts(version) {
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable major.minor.patch version, got ${version}`);
  }
  return version.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

export function releaseNotes(readme, version) {
  versionParts(version);
  const lines = readme.split(/\r?\n/);
  const changelog = lines.findIndex(line => line.trim() === '## Changelog');
  const start = lines.findIndex((line, i) => i > changelog && line.trim() === `### ${version}`);
  const sectionEnd = lines.findIndex((line, i) => i > changelog && /^#{1,2} /.test(line));
  if (changelog < 0 || start < 0 || (sectionEnd >= 0 && start >= sectionEnd)) {
    throw new Error(`README Changelog is missing version ${version}`);
  }
  let end = start + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes) throw new Error(`Changelog for ${version} is empty`);
  return notes + '\n';
}

export function releasePlan(version, releases) {
  versionParts(version);
  const tag = `v${version}`;
  const existing = releases.find(release => release.tag_name === tag);
  if (existing && !existing.draft) return { action: 'skip', existing };
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    // Historical 1.1.0 used "v.1.1.0"; preserve that tag and compare it correctly.
    const match = /^v\.?(\d+\.\d+\.\d+)$/.exec(release.tag_name);
    if (match && compareVersions(match[1], version) >= 0) {
      throw new Error(`Refusing to publish ${tag} after ${release.tag_name}; increase manifest.version`);
    }
  }
  return { action: existing ? 'resume' : 'create', existing };
}

function prepare(directory) {
  const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
  versionParts(version);
  const notes = releaseNotes(readFileSync('README.md', 'utf8'), version);
  const metadata = { version, tag: `v${version}`, asset: `pitchshifter-${version}.zip`, sha: process.env.GITHUB_SHA || null };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  writeFileSync(join(directory, 'notes.md'), notes);
  console.log(`Prepared ${metadata.tag}: ${metadata.asset}`);
}

async function publish(directory) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from main');
  if (!repository || !sha || !token) throw new Error('Missing GitHub release environment');
  const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
  const { version, tag, asset } = metadata;
  versionParts(version);
  if (metadata.sha !== sha || tag !== `v${version}` || asset !== `pitchshifter-${version}.zip`) {
    throw new Error('Artifact metadata does not match this workflow commit/version');
  }
  const notes = readFileSync(join(directory, 'notes.md'), 'utf8');
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const root = `${api}/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function request(url, { method = 'GET', body, binary = false, missing = false } = {}) {
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': binary ? 'application/zip' : 'application/json' } : {}) },
      body: body ? (binary ? body : JSON.stringify(body)) : undefined,
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${url.split('?')[0]} failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${root}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const plan = releasePlan(version, releases);
  if (plan.action === 'skip') {
    if (!plan.existing.assets.some(item => item.name === asset && item.state === 'uploaded')) {
      throw new Error(`${tag} is already published but is missing ${asset}; published releases are never overwritten`);
    }
    console.log(`${tag} is already published; leaving its tag and assets unchanged`);
    return;
  }
  const tagRef = await request(`${root}/git/ref/tags/${encodeURIComponent(tag)}`, { missing: true });
  if (tagRef) {
    let object = tagRef.object;
    while (object.type === 'tag') object = (await request(`${root}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== sha) throw new Error(`${tag} points to another commit; refusing to move it`);
  }
  if (plan.existing && plan.existing.target_commitish !== sha && !tagRef) {
    throw new Error(`${tag} has a draft for another commit; refusing to replace it`);
  }
  const bytes = readFileSync(join(directory, asset));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const release = plan.existing || await request(`${root}/releases`, {
    method: 'POST', body: { tag_name: tag, target_commitish: sha, name: `PitchShifter ${version}`, body: notes, draft: true, make_latest: 'false' },
  });
  const previousAsset = release.assets.find(item => item.name === asset);
  if (previousAsset) {
    if (previousAsset.state !== 'uploaded' || previousAsset.digest !== digest) {
      throw new Error(`Draft ${tag} already has a different/incomplete ${asset}; inspect it before retrying`);
    }
  } else {
    await request(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(asset)}`, { method: 'POST', body: bytes, binary: true });
  }
  // Publish only after the ZIP has uploaded; a failed upload leaves a draft.
  const published = await request(`${root}/releases/${release.id}`, {
    method: 'PATCH', body: { name: `PitchShifter ${version}`, body: notes, draft: false, make_latest: 'true' },
  });
  console.log(`Published ${published.html_url}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published [${tag}](${published.html_url}) as Latest with \`${asset}\`.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.env.RELEASE_DIR;
  if (!directory) throw new Error('Set RELEASE_DIR to the release artifact directory');
  if (process.argv[2] === 'prepare') prepare(directory);
  else if (process.argv[2] === 'publish') await publish(directory);
  else throw new Error('Usage: node release.mjs prepare|publish');
}
