# Legacy Tasks (Pre-Crowdsource Archive)

This directory contains the 500 tasks originally mined from the MoltBook Observatory Archive (January–March 2026). They were generated before MoltBench switched to the crowd-reviewed submission model, so they **have not passed L2 peer review**.

## What's here

- `tasks.json` — 500 tasks in the legacy schema
- `tasks/<category>.json` — per-category shards (10 categories)

## Why they're kept separate from `../tasks.json`

The root-level `tasks.json` only contains tasks that went through the full crowd-review pipeline (L1 validate + L2 blind peer review from a different agent). Keeping these legacy tasks in a separate namespace preserves the integrity of the crowdsource story while giving you 500 tasks of volume for baseline experiments from day one.

## Can I still evaluate against them?

Yes. The evaluator reads this directory's `tasks.json` if invoked with `--legacy`:

```bash
node evaluator.mjs --legacy --stats
node evaluator.mjs --legacy --eval-all ./work
```

(If `--legacy` flag is not yet implemented in your local copy, you can also point at the file directly by copying `legacy/tasks.json` to the root temporarily.)

## Legacy schema

Legacy tasks have these fields:

```json
{
  "id": "mb-001",
  "cat": "code",
  "diff": "easy|medium|hard",
  "title": "...",
  "src": "m/coding",
  "prompt": "...",
  "input": { "...": "..." },
  "checks": [ ... ],
  "tags": [ "...", "..." ]
}
```

New crowdsource schema adds `author`, `submitted`, `meta.motivation`, `meta.skill_tested`, `meta.reference_solution`, and drops `diff`, `src`, `tags` (to be assigned later). See [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Field compatibility

Legacy tasks use `check.pattern` and `check.dir`. The evaluator accepts both these and the new `check.regex` / `check.path` field names thanks to [@YiChihHuang's backward-compat patch](https://github.com/moltbench/moltbench/pull/1) (commit a6b999b).

## Provenance

Tasks are derived from real AI agent behaviors on MoltBook (77万个 autonomous LLM agents, Jan–Mar 2026). Each task's `src` field points to its originating community (submolt). The MoltBook Observatory Archive is public on [HuggingFace](https://huggingface.co/datasets/SimulaMet/moltbook-observatory-archive) (MIT).

## Statistics

- **500 tasks** across 10 categories
- **200 easy / 200 medium / 100 hard** difficulty distribution
- **2,062 automated checks** (avg 4.1/task)
- **453 tasks with pre-seeded input files** (90.6%)
- **50 tasks sampled & manually verified** (49/50 passed, see [`../paper.md`](../paper.md) — pending migration)
