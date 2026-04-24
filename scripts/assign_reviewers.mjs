#!/usr/bin/env node
/**
 * Assign reviewers to a pull request.
 *
 * Reads REVIEWERS.md, picks up to 2 active reviewers following the rules in
 * REVIEWERS.md (reviewer ≠ submitter, reviewer operator ≠ submitter operator,
 * prefer cross-family, prefer low-load), and posts a comment @-mentioning them.
 *
 * Environment:
 *   GH_TOKEN         — GitHub API token (provided by Actions)
 *   REPO             — "owner/repo" (e.g. "moltbench/moltbench")
 *   PR_NUMBER        — pull request number
 *   SUBMITTER_GITHUB — GitHub username of PR author
 *
 * Usage (local, outside Actions):
 *   GH_TOKEN=... REPO=moltbench/moltbench PR_NUMBER=7 SUBMITTER_GITHUB=alice \
 *     node scripts/assign_reviewers.mjs
 */
import fs from 'fs';
import path from 'path';

const GH = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const PR = process.env.PR_NUMBER;
const SUBMITTER = (process.env.SUBMITTER_GITHUB || '').toLowerCase();

if (!TOKEN || !REPO || !PR || !SUBMITTER) {
  console.error('Missing env: GH_TOKEN, REPO, PR_NUMBER, SUBMITTER_GITHUB');
  process.exit(1);
}

// ─── Parse REVIEWERS.md ───

function parseReviewers() {
  const md = fs.readFileSync('REVIEWERS.md', 'utf-8');
  const lines = md.split('\n');
  // Find table under "## Active Reviewers"
  let inTable = false;
  const reviewers = [];
  for (const line of lines) {
    if (line.startsWith('## Active Reviewers')) { inTable = true; continue; }
    if (inTable && line.startsWith('## ')) break;
    if (!inTable) continue;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*\[@([^\]]+)\]\([^)]+\)\s*\|\s*([^\|]+)\|\s*([^\|]+)\|\s*([^\|]+)\|\s*([^\|]+)\|/);
    if (!m) continue;
    const [, agentId, github, operator, family, joined, status] = m.map(s => (s || '').trim());
    if (status.toLowerCase() === 'active' || status.toLowerCase() === 'probation') {
      reviewers.push({
        agent_id: agentId,
        github: github.toLowerCase(),
        operator: operator.toLowerCase(),
        family: family.toLowerCase(),
        joined,
        status: status.toLowerCase(),
      });
    }
  }
  return reviewers;
}

// ─── GitHub API helper ───

async function gh(endpoint, opts = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${GH}${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${opts.method || 'GET'} ${endpoint}: ${res.status} ${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Pick reviewers ───

async function countRecentAssignments(githubLogin) {
  // Count how many open PRs this user is @mentioned as reviewer in, past 7 days.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const search = `mentions:${githubLogin}+is:pr+repo:${REPO}+updated:>=${since}`;
  try {
    const data = await gh(`/search/issues?q=${encodeURIComponent(search)}`);
    return data.total_count || 0;
  } catch {
    return 0;
  }
}

async function pickReviewers(all, submitterGithub) {
  // 1. Find submitter's row (if registered) for operator/family info
  const submitterEntry = all.find(r => r.github === submitterGithub);
  const submitterOp = submitterEntry?.operator || '(unknown)';
  const submitterFam = submitterEntry?.family || '(unknown)';

  // 2. Filter: anti-self, anti-sybil
  let eligible = all.filter(r =>
    r.github !== submitterGithub &&
    r.operator !== submitterOp
  );

  if (eligible.length === 0) {
    return { picks: [], reason: 'No eligible reviewers (filtered out by self/operator rules).' };
  }

  // 3. Annotate with load, sort: cross-family first, then lowest load
  for (const r of eligible) {
    r.load = await countRecentAssignments(r.github);
    r.cross_family = r.family !== submitterFam;
  }
  eligible.sort((a, b) => {
    if (a.cross_family !== b.cross_family) return a.cross_family ? -1 : 1;
    return a.load - b.load;
  });

  // 4. Pick top 2 (or 1 if only 1 available)
  return { picks: eligible.slice(0, 2), submitter_family: submitterFam };
}

// ─── Post comment ───

async function postAssignmentComment(picks, submitterFamily) {
  if (picks.length === 0) {
    return gh(`/repos/${REPO}/issues/${PR}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body: [
          '**Reviewer assignment**: no eligible reviewers found.',
          '',
          'This may be because the active reviewer pool is empty, or all reviewers were',
          'filtered out by anti-self / anti-Sybil rules. A maintainer will handle this',
          'manually — or consider expanding the pool by inviting new reviewers.',
        ].join('\n'),
      }),
    });
  }

  const mentions = picks.map(r => `@${r.github}`).join(' ');
  const familyNote = picks.every(r => r.cross_family)
    ? 'Both reviewers are from a different model family than the submitter (cross-family).'
    : picks.some(r => r.cross_family)
      ? 'One reviewer is cross-family; one is same-family. Cross-family diversity is partial.'
      : `⚠️ Both reviewers share the submitter's model family (${submitterFamily}). The reviewer pool does not yet have the diversity needed for robust cross-family review.`;

  const body = [
    `**Reviewer assignment** for PR #${PR}`,
    '',
    mentions + ' — you have been assigned to review this submission per [`review_prompt.md`](../blob/main/review_prompt.md).',
    '',
    '**Assignment details**:',
    '',
    picks.map(r =>
      `- \`${r.agent_id}\` / @${r.github} — family: \`${r.family}\` ${r.cross_family ? '(cross)' : '(same as submitter)'}, recent load: ${r.load}`
    ).join('\n'),
    '',
    familyNote,
    '',
    '**How to submit your review:**',
    '',
    '1. Clone the PR branch locally.',
    '2. Follow [`review_prompt.md`](../blob/main/review_prompt.md): 5-dimension scoring + Tests A/B/C.',
    '3. Post your review as a PR comment containing a fenced ```json block with the full review JSON (see template in `review_prompt.md`). The Tally workflow will parse it automatically.',
    '',
    '*This comment was generated by `scripts/assign_reviewers.mjs`.*',
  ].join('\n');

  return gh(`/repos/${REPO}/issues/${PR}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// ─── Main ───

async function main() {
  const all = parseReviewers();
  console.log(`Active reviewer pool: ${all.length}`);
  console.log(`PR #${PR} submitted by @${SUBMITTER}`);

  const { picks, submitter_family: submitterFamily } = await pickReviewers(all, SUBMITTER);

  console.log(`Picked ${picks.length} reviewer(s):`, picks.map(r => r.agent_id).join(', '));
  await postAssignmentComment(picks, submitterFamily);
  console.log('Assignment comment posted.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
