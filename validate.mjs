#!/usr/bin/env node
/**
 * MoltBench L1 Validator — automated validation for crowdsourced task submissions.
 *
 * Usage:
 *   node validate.mjs <submission.json>              Schema + safety checks only
 *   node validate.mjs --sandbox <submission.json>    Full validation including sandbox execution
 *   node validate.mjs --dedup <submission.json>      Check similarity against existing tasks
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

const CATEGORIES = ['code', 'data', 'text', 'file_ops', 'security', 'automation', 'sysadmin', 'api', 'reasoning', 'multi_step'];
const CHECK_TYPES = ['file_exists', 'file_match', 'file_not_match', 'run', 'json_valid', 'line_count', 'word_count', 'file_count'];
const FUNCTIONAL_TYPES = ['run', 'file_match', 'file_not_match', 'json_valid', 'line_count', 'word_count', 'file_count'];
const CMD_WHITELIST = /^(python3?|bash|node|cat|diff|wc|sort|head|tail|echo|test|ls)\b/;
const FORBIDDEN_PATTERNS = [/\brm\s+-rf\b/, /\bsudo\b/, /\bcurl\b/, /\bwget\b/, /\bfetch\b/, /\bnc\b/, /\bssh\b/, /\bscp\b/, /\bnslookup\b/, /\bdig\b/, /\bping\b/];

// ── Check runners (mirrored from evaluator.mjs) ──

function getEnv() {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (process.platform === 'win32') {
    const extra = [
      'C:\\ProgramData\\Anaconda3',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310'),
    ].filter(p => fs.existsSync(p));
    if (extra.length) env.PATH = extra.join(';') + ';' + (env.PATH || '');
  }
  return env;
}

function checkFileExists(check, dir) {
  return { type: 'file_exists', path: check.path, passed: fs.existsSync(path.join(dir, check.path)) };
}

function checkFileMatch(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const re = check.regex ?? check.pattern;
    const ok = re
      ? new RegExp(re, check.flags || '').test(content)
      : content.includes(check.text);
    return { type: 'file_match', path: check.path, passed: ok };
  } catch { return { type: 'file_match', path: check.path, passed: false }; }
}

function checkFileNotMatch(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const re = check.regex ?? check.pattern;
    const ok = re
      ? !new RegExp(re, check.flags || '').test(content)
      : !content.includes(check.text);
    return { type: 'file_not_match', path: check.path, passed: ok };
  } catch { return { type: 'file_not_match', path: check.path, passed: false }; }
}

function checkRun(check, dir) {
  try {
    const out = execSync(check.cmd, { cwd: dir, timeout: 30000, stdio: 'pipe', env: getEnv() }).toString();
    const exitOk = (check.exit ?? 0) === 0;
    let outputOk = true;
    if (check.stdout) outputOk = out.includes(check.stdout);
    if (check.stdout_pattern) outputOk = outputOk && new RegExp(check.stdout_pattern).test(out);
    return { type: 'run', cmd: check.cmd, passed: exitOk && outputOk };
  } catch (e) {
    const expectFail = (check.exit ?? 0) !== 0;
    const stderr = e.stderr ? e.stderr.toString().slice(0, 300) : '';
    const stdout = e.stdout ? e.stdout.toString().slice(0, 300) : '';
    let outputOk = true;
    if (check.stderr_contains) outputOk = stderr.includes(check.stderr_contains) || stdout.includes(check.stderr_contains);
    return { type: 'run', cmd: check.cmd, passed: expectFail && outputOk };
  }
}

function checkJsonValid(check, dir) {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, check.path), 'utf-8'));
    let ok = true;
    if (check.has_key) ok = ok && (check.has_key in obj);
    if (check.keys) ok = ok && check.keys.every(k => k in obj);
    if (check.is_array) ok = ok && Array.isArray(obj);
    if (check.min_length) ok = ok && (Array.isArray(obj) ? obj.length >= check.min_length : Object.keys(obj).length >= check.min_length);
    return { type: 'json_valid', path: check.path, passed: ok };
  } catch { return { type: 'json_valid', path: check.path, passed: false }; }
}

function checkLineCount(check, dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, check.path), 'utf-8').split('\n').filter(l => l.trim()).length;
    return { type: 'line_count', path: check.path, passed: lines >= (check.min || 0) && lines <= (check.max || Infinity) };
  } catch { return { type: 'line_count', path: check.path, passed: false }; }
}

function checkWordCount(check, dir) {
  try {
    const words = fs.readFileSync(path.join(dir, check.path), 'utf-8').split(/\s+/).filter(w => w).length;
    return { type: 'word_count', path: check.path, passed: words >= (check.min || 0) && words <= (check.max || Infinity) };
  } catch { return { type: 'word_count', path: check.path, passed: false }; }
}

function checkFileCount(check, dir) {
  try {
    const target = path.join(dir, check.dir || check.path || '.');
    const files = fs.readdirSync(target);
    const matched = check.pattern ? files.filter(f => new RegExp(check.pattern).test(f)) : files;
    return { type: 'file_count', passed: matched.length >= (check.min || 0) && matched.length <= (check.max || Infinity) };
  } catch { return { type: 'file_count', passed: false }; }
}

const RUNNERS = { file_exists: checkFileExists, file_match: checkFileMatch, file_not_match: checkFileNotMatch, run: checkRun, json_valid: checkJsonValid, line_count: checkLineCount, word_count: checkWordCount, file_count: checkFileCount };

function computeScore(checks, results) {
  let passed = 0, total = 0;
  for (let i = 0; i < checks.length; i++) {
    const w = checks[i].weight ?? 1;
    total += w;
    if (results[i].passed) passed += w;
  }
  return total > 0 ? +(passed / total).toFixed(4) : 0;
}

// ── Text similarity (word-level Jaccard for dedup) ──

function tokenize(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}

function jaccard(a, b) {
  const setA = tokenize(a), setB = tokenize(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── L1 Validation ──

function validateSchema(task) {
  const errors = [];

  if (!task.title || typeof task.title !== 'string') errors.push('missing or invalid "title"');
  else if (task.title.length > 60) errors.push(`title too long (${task.title.length} > 60 chars)`);

  if (!task.cat || !CATEGORIES.includes(task.cat)) errors.push(`invalid "cat": "${task.cat}" (must be one of: ${CATEGORIES.join(', ')})`);

  if (!task.author || typeof task.author !== 'string') errors.push('missing or invalid "author"');

  if (!task.prompt || typeof task.prompt !== 'string') errors.push('missing or invalid "prompt"');
  else if (task.prompt.length < 50) errors.push(`prompt too short (${task.prompt.length} < 50 chars)`);
  else if (task.prompt.length > 2000) errors.push(`prompt too long (${task.prompt.length} > 2000 chars)`);

  if (!Array.isArray(task.checks)) errors.push('missing or invalid "checks" (must be array)');
  else {
    if (task.checks.length < 2) errors.push(`too few checks (${task.checks.length} < 2)`);
    if (task.checks.length > 10) errors.push(`too many checks (${task.checks.length} > 10)`);
  }

  if (!task.meta || typeof task.meta !== 'object') errors.push('missing "meta" object');
  else {
    if (!task.meta.motivation || task.meta.motivation.length < 20) errors.push('meta.motivation missing or too short (< 20 chars)');
    if (!Array.isArray(task.meta.skill_tested) || task.meta.skill_tested.length < 1) errors.push('meta.skill_tested must be array with ≥ 1 entry');
    else if (task.meta.skill_tested.length > 5) errors.push('meta.skill_tested too many entries (> 5)');
    if (!task.meta.reference_solution || typeof task.meta.reference_solution !== 'object') errors.push('meta.reference_solution must be an object { filename: content }');
    else if (Object.keys(task.meta.reference_solution).length === 0) errors.push('meta.reference_solution is empty');
  }

  return errors;
}

function validateChecks(task) {
  const errors = [];
  if (!Array.isArray(task.checks)) return ['checks is not an array'];

  const allFileExists = task.checks.every(c => c.type === 'file_exists');
  if (allFileExists) errors.push('checks cannot all be file_exists — need at least one functional check');

  const hasFunctional = task.checks.some(c => FUNCTIONAL_TYPES.includes(c.type));
  if (!hasFunctional) errors.push('need at least one functional check (run, file_match, json_valid, etc.)');

  let totalWeight = 0, maxWeight = 0;
  for (let i = 0; i < task.checks.length; i++) {
    const c = task.checks[i];
    if (!CHECK_TYPES.includes(c.type)) {
      errors.push(`check[${i}]: unknown type "${c.type}"`);
      continue;
    }
    const w = c.weight ?? 1;
    if (!Number.isInteger(w) || w < 1 || w > 5) errors.push(`check[${i}]: weight must be integer 1-5, got ${w}`);
    totalWeight += w;
    if (w > maxWeight) maxWeight = w;
  }

  if (totalWeight > 0 && maxWeight / totalWeight > 0.5) {
    errors.push(`weight imbalance: single check weight ${maxWeight} exceeds 50% of total ${totalWeight}`);
  }

  return errors;
}

function validateSafety(task) {
  const errors = [];

  for (let i = 0; i < (task.checks || []).length; i++) {
    const c = task.checks[i];
    if (c.type === 'run' && c.cmd) {
      if (!CMD_WHITELIST.test(c.cmd.trim())) {
        errors.push(`check[${i}]: cmd "${c.cmd}" uses disallowed command (whitelist: python, bash, node, cat, diff, wc, sort, head, tail, echo, test, ls)`);
      }
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.test(c.cmd)) errors.push(`check[${i}]: cmd contains forbidden pattern ${pat}`);
      }
    }
  }

  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(task.prompt || '')) errors.push(`prompt contains forbidden pattern ${pat}`);
  }

  if (task.input && typeof task.input === 'object') {
    let totalSize = 0;
    for (const [name, content] of Object.entries(task.input)) {
      const size = Buffer.byteLength(content, 'utf-8');
      if (size > 50 * 1024) errors.push(`input file "${name}" exceeds 50 KB (${(size / 1024).toFixed(1)} KB)`);
      totalSize += size;
    }
    if (totalSize > 200 * 1024) errors.push(`total input size exceeds 200 KB (${(totalSize / 1024).toFixed(1)} KB)`);
  }

  return errors;
}

function validateWeights(task) {
  const errors = [];
  if (!Array.isArray(task.checks)) return errors;

  for (let i = 0; i < task.checks.length; i++) {
    const c = task.checks[i];
    const w = c.weight ?? 1;
    if (c.type === 'file_exists' && w > 2) {
      errors.push(`check[${i}]: file_exists with weight ${w} is unusual (suggested: 1)`);
    }
  }
  return errors;
}

// ── Sandbox execution ──

function runSandbox(task) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moltbench-validate-'));
  const results = { dir: tmpDir, checks: [], score: 0, errors: [] };

  try {
    if (task.input) {
      for (const [name, content] of Object.entries(task.input)) {
        const fp = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
      }
    }

    if (task.meta?.reference_solution) {
      for (const [name, content] of Object.entries(task.meta.reference_solution)) {
        const fp = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
      }
    }

    for (const check of task.checks) {
      const runner = RUNNERS[check.type];
      if (!runner) {
        results.checks.push({ type: check.type, passed: false, error: 'unknown type' });
        continue;
      }
      results.checks.push(runner(check, tmpDir));
    }

    results.score = computeScore(task.checks, results.checks);

    if (results.score < 1.0) {
      const failed = results.checks.map((r, i) => r.passed ? null : `check[${i}] ${r.type}: ${r.path || r.cmd || ''}`).filter(Boolean);
      results.errors.push(`reference solution scored ${results.score} (need 1.0). Failed: ${failed.join('; ')}`);
    }
  } catch (e) {
    results.errors.push(`sandbox error: ${e.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return results;
}

// ── Dedup check ──

function checkDuplicates(task) {
  const errors = [];
  const tasksFile = path.join(ROOT, 'tasks.json');
  if (!fs.existsSync(tasksFile)) return errors;

  const existing = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
  const newText = `${task.title} ${task.prompt}`;

  for (const t of existing) {
    const oldText = `${t.title} ${t.prompt}`;
    const sim = jaccard(newText, oldText);
    if (sim >= 0.85) {
      errors.push(`too similar to existing task ${t.id} "${t.title}" (similarity: ${(sim * 100).toFixed(0)}%)`);
    }
  }

  return errors;
}

// ── Main ──

function printSection(label, errors, warnings) {
  const icon = errors.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\n[${icon}] ${label}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  for (const w of (warnings || [])) console.log(`  WARN:  ${w}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`MoltBench L1 Validator

Usage:
  node validate.mjs <submission.json>              Schema + safety checks
  node validate.mjs --sandbox <submission.json>    Full validation (runs reference solution)
  node validate.mjs --dedup <submission.json>      Check for duplicates against tasks.json

Flags can be combined:
  node validate.mjs --sandbox --dedup <submission.json>

Exit codes: 0 = all passed, 1 = validation failed, 2 = usage error`);
    return;
  }

  const doSandbox = args.includes('--sandbox');
  const doDedup = args.includes('--dedup');
  const jsonFile = args.filter(a => !a.startsWith('--')).pop();

  if (!jsonFile || !fs.existsSync(jsonFile)) {
    console.error(`File not found: ${jsonFile}`);
    process.exit(2);
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  } catch (e) {
    console.error(`Invalid JSON: ${e.message}`);
    process.exit(2);
  }

  console.log(`MoltBench L1 Validation: ${jsonFile}`);
  console.log(`Task: "${task.title || '(no title)'}" [${task.cat || '?'}]`);
  console.log('='.repeat(60));

  let allErrors = [];

  // Schema
  const schemaErrors = validateSchema(task);
  printSection('Schema', schemaErrors);
  allErrors.push(...schemaErrors);

  // Checks structure
  const checkErrors = validateChecks(task);
  const weightWarnings = validateWeights(task);
  printSection('Checks', checkErrors, weightWarnings);
  allErrors.push(...checkErrors);

  // Safety
  const safetyErrors = validateSafety(task);
  printSection('Safety', safetyErrors);
  allErrors.push(...safetyErrors);

  // Sandbox
  if (doSandbox) {
    if (allErrors.length > 0) {
      console.log('\n[SKIP] Sandbox — fix schema/check/safety errors first');
    } else {
      const sandbox = runSandbox(task);
      printSection('Sandbox (reference solution)', sandbox.errors);
      if (sandbox.errors.length === 0) {
        console.log(`  Reference solution score: ${sandbox.score}`);
        console.log(`  Checks passed: ${sandbox.checks.filter(c => c.passed).length}/${sandbox.checks.length}`);
      }
      allErrors.push(...sandbox.errors);
    }
  }

  // Dedup
  if (doDedup) {
    const dupErrors = checkDuplicates(task);
    printSection('Duplicate check', dupErrors);
    allErrors.push(...dupErrors);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  if (allErrors.length === 0) {
    console.log('RESULT: L1 PASSED');
    const steps = [];
    if (!doSandbox) steps.push('--sandbox');
    if (!doDedup) steps.push('--dedup');
    if (steps.length) console.log(`  (also run with ${steps.join(' ')} for full validation)`);
  } else {
    console.log(`RESULT: L1 FAILED (${allErrors.length} error${allErrors.length > 1 ? 's' : ''})`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(2); });
