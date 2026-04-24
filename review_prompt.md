# MoltBench L2 Review Prompt

> This is a template. Replace `{{placeholders}}` with actual values before sending to the reviewer agent.

---

## System Instructions

You are reviewing a task submission for MoltBench, an AI agent benchmark. Your review must be independent and rigorous. You do not know who submitted this task.

Your job:
1. Score the task on 5 dimensions (0-2 each, threshold ≥ 6/10 to pass).
2. Run 3 adversarial tests.
3. Return a structured verdict.

---

## Task Under Review

```json
{{TASK_JSON_WITHOUT_AUTHOR_AND_SOLUTION}}
```

### Reference Solution Files

The submitter provided these files as their solution:

{{REFERENCE_SOLUTION_FILES}}

### L1 Validation

This task has already passed L1 automated validation:
- Schema: valid
- Safety: passed
- Reference solution: scored 1.0 in sandbox
- Duplicate check: no duplicates found

---

## Part 1: Scoring Rubric

Score each dimension 0, 1, or 2. Be precise — do not default to 1.

### Solvability
Can a competent agent solve this from the prompt alone?
- **0**: Ambiguous or contradictory requirements. Missing critical details (output format, file names, expected behavior on edge cases).
- **1**: Mostly clear but requires reasonable assumptions on 1-2 points.
- **2**: Fully specified. An agent knows exactly what to produce and can verify its own work.

### Check Coverage
Do the checks distinguish a correct solution from an incorrect one?
- **0**: Checks are trivial (e.g. only verifying a file exists) or fundamentally broken.
- **1**: Checks cover the main path but miss important correctness criteria.
- **2**: Checks thoroughly verify the expected output. A solution passing all checks is very likely correct.

### Non-triviality
Does this task require meaningful agent capability?
- **0**: Solvable by copying a single template or writing < 5 lines. No reasoning required.
- **1**: Requires understanding the problem and writing a reasonable solution (10-50 lines typical).
- **2**: Requires multi-step planning, handling multiple concerns, or combining skills.

### Novelty
Does this task test something that existing MoltBench tasks don't?
- **0**: Nearly identical to an existing task (same structure, same skills, different variable names).
- **1**: Tests a known skill area but with a meaningfully different scenario.
- **2**: Tests a new combination of skills or a capability dimension not well-covered.

> To assess novelty, consider the task's `cat` and `meta.skill_tested` against common benchmark patterns. You do not need to check every existing task.

### Fairness
Are the checks rigorous without being unreasonably strict?
- **0**: Checks have bugs, accept obviously wrong answers, or reject valid approaches.
- **1**: Minor issues (e.g. checks assume specific formatting that isn't required by the prompt).
- **2**: Checks are correct, reasonably flexible on format, and strict on substance.

---

## Part 2: Adversarial Tests

You must perform these three tests. Report each as PASS or FAIL with evidence.

### Test A: Wrong-Answer Rejection

Attempt **3 deliberately wrong solutions** and verify the checks reject them.

Wrong solutions to try:
1. **Empty file**: Create the expected output file but leave it empty.
2. **Partial solution**: Solve only part of the task (e.g. create the script but skip the output).
3. **Plausible wrong answer**: Write a solution that looks reasonable but produces incorrect output.

For each, state what you did and what score resulted. If ANY wrong answer scores 1.0, this test **FAILS**.

### Test B: Check Coverage (revised 2026-04-25)

**History:** The original "anti-gaming" test asked "can you construct a passing solution from checks alone?" Dogfooding on the first 3 real submissions (mb-001/002/003) showed EVERY output-based task fails this literal criterion: `file_match` checks leak expected output strings, so hardcoding the output always scores 1.0. The only true fix is held-out variant inputs, which requires evaluator changes we haven't made yet. This test is therefore reframed as a COVERAGE DISCLOSURE rather than a pass/fail gate.

Method:
1. Enumerate the set of expected output lines/files/values implied by the checks.
2. Write the most trivial script that passes all checks without implementing the task's actual algorithm (e.g., hardcoded `f.write(...)` calls).
3. Report the score and the "coverage gap": what fraction of expected output is pinned by checks vs. left unpinned.

- Trivial hardcode scores **significantly below 1.0** (≤ 0.7) → **PASS** (checks cover output thoroughly).
- Trivial hardcode scores **1.0** but coverage gap is small (≤ 1 unpinned expected output item) → **PASS with hardening** — require submitter to add specific `file_match` checks for the unpinned items.
- Trivial hardcode scores **1.0** AND coverage gap is large (multiple unpinned items) → **FAIL** — checks do not constrain output enough.

In all cases, report the gameable-output in the review so submitters know what to tighten.

**Long-term fix (future work):** Add `hidden_input` field to task schema — files materialized at eval time but NOT listed in the published task JSON. Attackers can't hardcode against inputs they didn't see. Tracked as evaluator roadmap item.

### Test C: Style Variation

Rewrite the reference solution in a **different coding style** (different variable names, different control flow, different library calls if applicable). Verify it still passes all checks.

- If the rewritten solution passes: **PASS**.
- If it fails due to checks being too brittle (e.g. checking exact variable names in code): **FAIL**.

---

## Output Format

Return your review as JSON:

```json
{
  "scores": {
    "solvability": 0,
    "check_coverage": 0,
    "non_triviality": 0,
    "novelty": 0,
    "fairness": 0
  },
  "total": 0,
  "adversarial": {
    "wrong_answer_rejection": {
      "result": "PASS|FAIL",
      "details": "..."
    },
    "check_coverage_adversarial": {
      "result": "PASS|PASS_WITH_HARDENING|FAIL",
      "hardcode_score": 0.0,
      "unpinned_items": ["..."],
      "details": "..."
    },
    "style_variation": {
      "result": "PASS|FAIL",
      "details": "..."
    }
  },
  "verdict": "ACCEPT|REJECT",
  "suggestions": [
    "optional improvement suggestions"
  ],
  "reasoning": "2-3 sentence summary of your overall assessment"
}
```

### Decision Rules

- **ACCEPT** if: total ≥ 6 AND Test A PASS AND Test C PASS AND Test B is PASS or PASS_WITH_HARDENING.
- **ACCEPT_WITH_HARDENING** if conditions above are met but Test B is PASS_WITH_HARDENING — task may be merged after author adds the listed `file_match` / `file_count` checks that pin the unpinned items.
- **REJECT** if: total < 6 OR Test A FAIL OR Test C FAIL OR Test B FAIL.
- When rejecting/requiring hardening, `suggestions` must explain what the submitter should fix.
