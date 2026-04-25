#!/usr/bin/env node
/**
 * Convert selected legacy tasks into crowd-format submissions by
 * adding author/submitted/meta + reference_solution and weight on checks.
 *
 * Output: submissions/xiaojin/<slug>.json
 *
 * Run: node scripts/convert_legacy.mjs
 */
import fs from 'fs';
import path from 'path';

const LEGACY = JSON.parse(fs.readFileSync('legacy/tasks.json', 'utf-8'));
const OUT_DIR = 'submissions/xiaojin';
fs.mkdirSync(OUT_DIR, { recursive: true });

const NOW = '2026-04-25T03:00:00Z';
const AUTHOR = 'agent:xiaojin';

// ── Reference solutions (one per task we're converting) ──

const REF = {
  'mb-029': {
    'sort_fixed.py': `import sys

def merge_sort(arr):
    if len(arr) <= 1:
        return arr
    mid = len(arr) // 2
    left = merge_sort(arr[:mid])
    right = merge_sort(arr[mid:])
    return merge(left, right)

def merge(left, right):
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result

if __name__ == '__main__':
    nums = [int(x) for x in sys.argv[1:]]
    print(' '.join(str(x) for x in merge_sort(nums)))
`,
  },
  'mb-099': {
    'solution.py': `import csv

users = {}
with open('users.csv', newline='') as f:
    for row in csv.DictReader(f):
        users[row['user_id']] = row['name']

with open('orders.csv', newline='') as fin, open('joined.csv', 'w', newline='') as fout:
    reader = csv.DictReader(fin)
    writer = csv.writer(fout)
    writer.writerow(['user_id', 'name', 'order_id', 'amount'])
    for row in reader:
        if row['user_id'] in users:
            writer.writerow([row['user_id'], users[row['user_id']], row['order_id'], row['amount']])
`,
  },
  'mb-161': {
    'gen_api_docs.py':
      "import json\n" +
      "with open('api.json') as f:\n" +
      "    endpoints = json.load(f)\n" +
      "out = ['# API Documentation', '']\n" +
      "for ep in endpoints:\n" +
      "    out.append('## ' + ep['method'] + ' ' + ep['path'])\n" +
      "    out.append('')\n" +
      "    out.append(ep['description'])\n" +
      "    out.append('')\n" +
      "    out.append('### Parameters')\n" +
      "    out.append('')\n" +
      "    out.append('| name | type | required |')\n" +
      "    out.append('|------|------|----------|')\n" +
      "    for p in ep.get('params', []):\n" +
      "        req = 'yes' if p.get('required') else 'no'\n" +
      "        out.append('| ' + p['name'] + ' | ' + p['type'] + ' | ' + req + ' |')\n" +
      "    out.append('')\n" +
      "    out.append('### Response')\n" +
      "    out.append('')\n" +
      "    out.append('```json')\n" +
      "    out.append(json.dumps(ep.get('response', {}), indent=2))\n" +
      "    out.append('```')\n" +
      "    out.append('')\n" +
      "with open('API.md', 'w') as f:\n" +
      "    f.write('\\n'.join(out))\n",
  },
  'mb-257': {
    'sql_scanner.py':
      "import sys, json, re\n" +
      "filename = sys.argv[1]\n" +
      "with open(filename) as f:\n" +
      "    lines = f.read().splitlines()\n" +
      "vulns = []\n" +
      "unsafe = 0\n" +
      "safe = 0\n" +
      "fix_msg = \"Use parameterized queries: cursor.execute('... WHERE x = ?', (value,))\"\n" +
      "for i, line in enumerate(lines, 1):\n" +
      "    has_sql = bool(re.search(r'\\b(SELECT|INSERT|UPDATE|DELETE)\\b', line, re.IGNORECASE))\n" +
      "    if not has_sql:\n" +
      "        continue\n" +
      "    if re.search(r\"'\\s*\\+\\s*\\w+\\s*\\+\\s*'\", line) or re.search(r'\"\\s*\\+\\s*\\w+\\s*\\+\\s*\"', line):\n" +
      "        vulns.append({\"line\": i, \"code\": line.strip(), \"type\": \"string-concatenation\", \"fix\": fix_msg})\n" +
      "        unsafe += 1\n" +
      "    elif re.search(r'f\"[^\"]*\\{', line) or re.search(r\"f'[^']*\\{\", line):\n" +
      "        vulns.append({\"line\": i, \"code\": line.strip(), \"type\": \"f-string\", \"fix\": fix_msg})\n" +
      "        unsafe += 1\n" +
      "    elif '%d' in line or '%s' in line:\n" +
      "        vulns.append({\"line\": i, \"code\": line.strip(), \"type\": \"percent-formatting\", \"fix\": fix_msg})\n" +
      "        unsafe += 1\n" +
      "    elif '.format(' in line:\n" +
      "        vulns.append({\"line\": i, \"code\": line.strip(), \"type\": \"format-method\", \"fix\": fix_msg})\n" +
      "        unsafe += 1\n" +
      "    elif '?' in line:\n" +
      "        safe += 1\n" +
      "result = {\"file\": filename, \"vulnerabilities\": vulns, \"safe_queries\": safe, \"unsafe_queries\": unsafe}\n" +
      "with open('scan_result.json', 'w') as f:\n" +
      "    json.dump(result, f, indent=2)\n",
  },
  'mb-405': {
    'adr_generator.py': `with open('requirements.txt') as f:
    reqs = f.read()

content = '''# ADR-001: Message Queue Selection for Real-Time Analytics Pipeline

## Status

Accepted

## Context

''' + reqs + '''

The system requires high-throughput, ordered, replayable event processing
with multiple independent consumer groups, low operational overhead, and
sub-100ms P99 latency. We evaluated three message queue options to support
this real-time analytics pipeline for our e-commerce platform.

## Decision

We will use Apache Kafka for the message queue infrastructure.

Kafka uniquely satisfies the combination of constraints: 50,000 events/second
peak throughput is well within Kafka's documented capability of millions of
messages per second per broker. Per-partition ordering aligns naturally with
per-customer-session ordering by partitioning on customer ID. The 7-day
retention requirement maps directly to Kafka's configurable log retention.
Five independent consumer groups reading the same stream is Kafka's primary
consumption model — each group maintains its own offset without affecting
others.

The P99 100ms latency requirement is achievable with appropriate batch and
linger settings. The team's preference for managed/simple operations is
addressed by using a managed Kafka service (Confluent Cloud, AWS MSK, or
similar) rather than self-hosted clusters.

## Alternatives Considered

### RabbitMQ — Rejected

RabbitMQ is excellent for traditional message queuing patterns and routing
flexibility, but its design assumes work-queue semantics where messages are
consumed once and removed. The requirement for 5 independent consumer groups
reading the same stream does not fit RabbitMQ's primary model and would
require fan-out exchanges with per-consumer queues, multiplying storage and
complicating retention. The 7-day retention with replay capability is also
not a RabbitMQ strength.

### Redis Streams — Rejected

Redis Streams provides log-based semantics similar to Kafka and is operationally
simpler. However, Redis Streams retention is bounded by available memory,
making 7-day retention at 50K events/second prohibitively expensive. Throughput
under sustained high load is also a concern compared to Kafka's optimized
disk-based log structure.

## Consequences

### Positive

- Native support for ordered, partitioned, replayable streams
- Multi-consumer-group semantics built in
- Mature managed offerings reduce operational burden
- Throughput and retention requirements met with significant headroom

### Negative

- Higher per-message latency floor than Redis (Kafka batches for throughput)
- Managed Kafka costs scale with throughput and retention
- Team needs to learn partitioning model and consumer-group semantics
- Cross-region replication adds operational complexity if needed later
'''

with open('adr-001.md', 'w') as f:
    f.write(content)
`,
  },
};

const MOTIVATION = {
  'mb-029': 'Debugging existing code is one of the most common agent tasks — far more common than writing greenfield code. Tests an agent\'s ability to identify subtle algorithmic bugs (here: missing index increments after merge) and fix them without rewriting from scratch.',
  'mb-099': 'CSV inner join is a foundational data-engineering primitive. Real agents constantly join tabular data without pandas (e.g., in restricted runtimes). Tests stdlib CSV handling plus correctly dropping unmatched rows on both sides of the join.',
  'mb-161': 'Generating documentation from machine-readable specs is a frequent agent task in API-first development. Tests structured data parsing, markdown templating, and table generation simultaneously.',
  'mb-257': 'Static analysis for SQL injection is a real auditing task agents are asked to perform. Tests pattern recognition across multiple injection styles (concat, f-string, %-format) and structured JSON output with actionable fix suggestions.',
  'mb-405': 'Architecture Decision Records are a standard professional artifact agents are increasingly asked to produce. Tests requirement analysis, comparative reasoning across options, and structured technical writing within strict section constraints.',
};

const SKILL_TESTED = {
  'mb-029': ['debugging', 'algorithms', 'cli-args'],
  'mb-099': ['csv-processing', 'inner-join', 'file-io'],
  'mb-161': ['markdown-generation', 'json-parsing', 'templating'],
  'mb-257': ['static-analysis', 'security', 'pattern-matching', 'json-output'],
  'mb-405': ['technical-writing', 'requirements-analysis', 'comparative-reasoning'],
};

// Add weights to checks (heuristic: file_exists=1, run/match=2, harder validations=3)
function addWeights(checks) {
  return checks.map(c => {
    let w = 1;
    if (c.type === 'file_exists') w = 1;
    else if (c.type === 'run') w = 3;
    else if (c.type === 'json_valid') w = 2;
    else if (c.type === 'file_match' || c.type === 'file_not_match') w = 2;
    else if (c.type === 'line_count' || c.type === 'word_count' || c.type === 'file_count') w = 2;
    return { ...c, weight: w };
  });
}

const TARGETS = ['mb-029', 'mb-099', 'mb-161', 'mb-257', 'mb-405'];

for (const id of TARGETS) {
  const orig = LEGACY.find(t => t.id === id);
  if (!orig) { console.error(`Legacy task ${id} not found`); continue; }

  const slug = orig.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const converted = {
    id: null,
    title: orig.title,
    cat: orig.cat,
    author: AUTHOR,
    submitted: NOW,
    prompt: orig.prompt,
    input: orig.input || {},
    checks: addWeights(orig.checks),
    meta: {
      motivation: MOTIVATION[id],
      skill_tested: SKILL_TESTED[id],
      reference_solution: REF[id],
    },
  };

  const outFile = path.join(OUT_DIR, `${slug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(converted, null, 2) + '\n');
  console.log(`✓ ${id} → ${outFile}`);
}
