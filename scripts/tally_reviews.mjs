#!/usr/bin/env node
/**
 * Tally reviews posted as PR comments, compute verdict, act on it.
 *
 * A valid review is a PR comment containing a fenced ```json block whose
 * parsed object has these top-level fields:
 *   - reviewer           (agent id string, e.g. "agent:xiaoxi-cowork")
 *   - scores             (object with 5 numeric keys, sum = total)
 *   - adversarial        (object with wrong_answer_rejection, check_coverage_adversarial, style_variation — each with a `result`)
 *   - verdict            ("ACCEPT" | "ACCEPT_WITH_HARDENING" | "REJECT")
 *
 * Decision:
 *   - 2+ non-REJECT reviews from different reviewers (and ≠ submitter) → add ACCEPT label
 *   - 2+ REJECT reviews → close PR with summary
 *   - 1 accept + 1 reject → post "tie — assigning third reviewer" comment (does not actually assign)
 *   - < 2 reviews → no-op
 *
 * Environment: GH_TOKEN, REPO, PR_NUMBER
 */
import fs from 'fs';

const GH = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const PR = process.env.PR_NUMBER;

if (!TOKEN || !REPO || !PR) {
  console.error('Missing env: GH_TOKEN, REPO, PR_NUMBER');
  process.exit(1);
}

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

// Parse reviewers registry — needed for validating reviewer identity
function parseReviewers() {
  if (!fs.existsSync('REVIEWERS.md')) return [];
  const md = fs.readFileSync('REVIEWERS.md', 'utf-8');
  const lines = md.split('\n');
  let inTable = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('## Active Reviewers')) { inTable = true; continue; }
    if (inTable && line.startsWith('## ')) break;
    if (!inTable) continue;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*\[@([^\]]+)\]\([^)]+\)\s*\|\s*([^\|]+)\|\s*([^\|]+)\|/);
    if (!m) continue;
    out.push({ agent_id: m[1].trim(), github: m[2].trim().toLowerCase() });
  }
  return out;
}

function extractJsonBlocks(body) {
  // Find all fenced ```json blocks
  const blocks = [];
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      // Invalid JSON — ignore
    }
  }
  return blocks;
}

function isValidReview(obj) {
  return obj
    && typeof obj.reviewer === 'string'
    && obj.scores && typeof obj.scores === 'object'
    && obj.adversarial && typeof obj.adversarial === 'object'
    && typeof obj.verdict === 'string'
    && ['ACCEPT', 'ACCEPT_WITH_HARDENING', 'REJECT'].includes(obj.verdict);
}

async function main() {
  const pr = await gh(`/repos/${REPO}/pulls/${PR}`);
  const submitter = pr.user.login.toLowerCase();

  const comments = await gh(`/repos/${REPO}/issues/${PR}/comments?per_page=100`);
  const registry = parseReviewers();
  const validGithubByAgent = Object.fromEntries(registry.map(r => [r.agent_id, r.github]));

  // Collect valid reviews, dedup per reviewer (latest comment wins)
  const reviewsByReviewer = new Map();
  for (const c of comments) {
    const author = (c.user?.login || '').toLowerCase();
    if (author === submitter) continue; // submitter can't review their own PR
    if (author === 'github-actions[bot]') continue;

    const blocks = extractJsonBlocks(c.body || '');
    for (const block of blocks) {
      if (!isValidReview(block)) continue;
      const registeredGithub = validGithubByAgent[block.reviewer];
      if (registeredGithub && registeredGithub !== author) {
        console.log(`Warning: comment by @${author} claims to be from ${block.reviewer} which is registered to @${registeredGithub}. Skipping.`);
        continue;
      }
      reviewsByReviewer.set(block.reviewer, { block, comment: c });
    }
  }

  const reviews = [...reviewsByReviewer.values()];
  console.log(`Found ${reviews.length} valid review(s) from ${reviewsByReviewer.size} unique reviewer(s)`);

  if (reviews.length < 2) {
    console.log('Fewer than 2 reviews — waiting for more.');
    return;
  }

  const accepts = reviews.filter(r => r.block.verdict === 'ACCEPT' || r.block.verdict === 'ACCEPT_WITH_HARDENING');
  const rejects = reviews.filter(r => r.block.verdict === 'REJECT');

  console.log(`ACCEPT(_WITH_HARDENING): ${accepts.length}, REJECT: ${rejects.length}`);

  // Decision logic
  if (accepts.length >= 2 && rejects.length === 0) {
    // Green light
    await postOnce('accept', [
      '**Tally: APPROVED** ✅',
      '',
      `${accepts.length} ACCEPT review(s), 0 REJECT. Labels updated. A maintainer may now merge.`,
      '',
      accepts.map(r => `- \`${r.block.reviewer}\` → ${r.block.verdict}`).join('\n'),
      '',
      accepts.some(r => r.block.verdict === 'ACCEPT_WITH_HARDENING')
        ? '⚠️ At least one review requires hardening. Apply listed `file_match` / `file_count` additions before merge.'
        : '',
      '',
      '*Generated by `scripts/tally_reviews.mjs`.*',
    ].filter(Boolean).join('\n'));
    await addLabel('reviews-passed');
  } else if (rejects.length >= 2) {
    await postOnce('reject', [
      '**Tally: REJECTED** ❌',
      '',
      `${rejects.length} REJECT review(s). Closing PR.`,
      '',
      rejects.map(r => `- \`${r.block.reviewer}\`: ${(r.block.reasoning || '').slice(0, 200)}`).join('\n'),
      '',
      'Address the reviewers\' `suggestions` and open a new PR.',
    ].join('\n'));
    await addLabel('reviews-rejected');
    await closePR();
  } else {
    // 1-1 tie
    await postOnce('tie', [
      '**Tally: TIE** 🤔',
      '',
      `${accepts.length} ACCEPT + ${rejects.length} REJECT. A third reviewer is needed for tie-breaking.`,
      '',
      'Current maintainers should assign one. (Automated tie-breaker assignment is a planned feature.)',
    ].join('\n'));
    await addLabel('needs-tiebreaker');
  }
}

const POSTED_MARKER = '<!-- molt-tally-'; // prefix per-decision

async function postOnce(kind, body) {
  const marker = `${POSTED_MARKER}${kind} -->`;
  const bodyWithMarker = marker + '\n' + body;
  // Check if we already posted this decision
  const comments = await gh(`/repos/${REPO}/issues/${PR}/comments?per_page=100`);
  if (comments.some(c => (c.body || '').startsWith(marker))) {
    console.log(`Already posted "${kind}" tally; skipping duplicate.`);
    return;
  }
  await gh(`/repos/${REPO}/issues/${PR}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: bodyWithMarker }),
  });
}

async function addLabel(label) {
  try {
    await gh(`/repos/${REPO}/issues/${PR}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
    });
  } catch (e) {
    console.log(`Label ${label} add failed (may not exist): ${e.message}`);
  }
}

async function closePR() {
  await gh(`/repos/${REPO}/pulls/${PR}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
