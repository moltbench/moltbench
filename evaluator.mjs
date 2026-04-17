#!/usr/bin/env node
/**
 * MoltBench Evaluator — scores agent task completions.
 *
 * Usage:
 *   node evaluator.mjs --stats                         Benchmark statistics
 *   node evaluator.mjs --list [--cat code]              List tasks (optionally filtered)
 *   node evaluator.mjs --show <task_id>                 Show task prompt
 *   node evaluator.mjs --eval <task_id> <work_dir>      Evaluate one task
 *   node evaluator.mjs --eval-all <results_dir>         Evaluate all (dirs named mb-NNN)
 *   node evaluator.mjs --setup <task_id> <work_dir>     Create input files for a task
 *   node evaluator.mjs --export-prompts <out_dir>       Export all prompts as text files
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

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

function loadTasks() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks.json'), 'utf-8'));
}

// ── Check runners ──

function checkFileExists(check, dir) {
  const p = path.join(dir, check.path);
  const ok = fs.existsSync(p);
  return { type: 'file_exists', path: check.path, passed: ok };
}

function checkFileMatch(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const ok = check.pattern
      ? new RegExp(check.pattern, check.flags || '').test(content)
      : content.includes(check.text);
    return { type: 'file_match', path: check.path, passed: ok };
  } catch {
    return { type: 'file_match', path: check.path, passed: false, error: 'file not found' };
  }
}

function checkFileNotMatch(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const ok = check.pattern
      ? !new RegExp(check.pattern, check.flags || '').test(content)
      : !content.includes(check.text);
    return { type: 'file_not_match', path: check.path, passed: ok };
  } catch {
    return { type: 'file_not_match', path: check.path, passed: false, error: 'file not found' };
  }
}

function checkRun(check, dir) {
  try {
    const out = execSync(check.cmd, {
      cwd: dir,
      timeout: check.timeout || 30000,
      stdio: 'pipe',
      env: getEnv(),
    }).toString();
    const exitOk = (check.exit ?? 0) === 0;
    let outputOk = true;
    if (check.stdout) outputOk = out.includes(check.stdout);
    if (check.stdout_pattern) outputOk = outputOk && new RegExp(check.stdout_pattern).test(out);
    return { type: 'run', cmd: check.cmd, passed: exitOk && outputOk, stdout: out.slice(0, 500) };
  } catch (e) {
    const expectFail = (check.exit ?? 0) !== 0;
    const stderr = e.stderr ? e.stderr.toString().slice(0, 300) : '';
    const stdout = e.stdout ? e.stdout.toString().slice(0, 300) : '';
    let outputOk = true;
    if (check.stderr_contains) outputOk = stderr.includes(check.stderr_contains) || stdout.includes(check.stderr_contains);
    return { type: 'run', cmd: check.cmd, passed: expectFail && outputOk, stderr: stderr.slice(0, 300) };
  }
}

function checkJsonValid(check, dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const obj = JSON.parse(raw);
    let ok = true;
    if (check.has_key) ok = ok && (check.has_key in obj);
    if (check.is_array) ok = ok && Array.isArray(obj);
    if (check.min_length) ok = ok && (Array.isArray(obj) ? obj.length >= check.min_length : Object.keys(obj).length >= check.min_length);
    return { type: 'json_valid', path: check.path, passed: ok };
  } catch {
    return { type: 'json_valid', path: check.path, passed: false };
  }
}

function checkLineCount(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim()).length;
    const ok = lines >= (check.min || 0) && lines <= (check.max || Infinity);
    return { type: 'line_count', path: check.path, lines, passed: ok };
  } catch {
    return { type: 'line_count', path: check.path, passed: false };
  }
}

function checkFileCount(check, dir) {
  try {
    const target = path.join(dir, check.dir || '.');
    const files = fs.readdirSync(target);
    const matched = check.pattern
      ? files.filter(f => new RegExp(check.pattern).test(f))
      : files;
    const ok = matched.length >= (check.min || 0) && matched.length <= (check.max || Infinity);
    return { type: 'file_count', dir: check.dir, count: matched.length, passed: ok };
  } catch {
    return { type: 'file_count', passed: false };
  }
}

function checkWordCount(check, dir) {
  try {
    const content = fs.readFileSync(path.join(dir, check.path), 'utf-8');
    const words = content.split(/\s+/).filter(w => w).length;
    const ok = words >= (check.min || 0) && words <= (check.max || Infinity);
    return { type: 'word_count', path: check.path, words, passed: ok };
  } catch {
    return { type: 'word_count', path: check.path, passed: false };
  }
}

const RUNNERS = {
  file_exists: checkFileExists,
  file_match: checkFileMatch,
  file_not_match: checkFileNotMatch,
  run: checkRun,
  json_valid: checkJsonValid,
  line_count: checkLineCount,
  file_count: checkFileCount,
  word_count: checkWordCount,
};

// ── Evaluate one task ──

function evaluate(task, workDir) {
  const results = { task_id: task.id, title: task.title, category: task.cat, difficulty: task.diff, checks: [] };
  let passed = 0, total = 0;

  for (const check of (task.checks || [])) {
    const runner = RUNNERS[check.type];
    if (!runner) {
      results.checks.push({ type: check.type, passed: false, error: 'unknown check type' });
      total++;
      continue;
    }
    const w = check.weight ?? 1;
    const r = runner(check, workDir);
    r.weight = w;
    results.checks.push(r);
    total += w;
    if (r.passed) passed += w;
  }

  results.score = total > 0 ? +(passed / total).toFixed(4) : 0;
  results.passed = results.score >= (task.pass_threshold ?? 0.6);
  results.checks_passed = results.checks.filter(c => c.passed).length;
  results.checks_total = results.checks.length;
  return results;
}

// ── Setup workspace ──

function setupWorkspace(task, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  if (task.input) {
    for (const [name, content] of Object.entries(task.input)) {
      const fp = path.join(workDir, name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
  }
}

// ── Format task prompt ──

function formatPrompt(task) {
  let prompt = `# MoltBench Task: ${task.id}\n`;
  prompt += `**Category**: ${task.cat} | **Difficulty**: ${task.diff}\n\n`;
  prompt += `## ${task.title}\n\n`;
  prompt += task.prompt + '\n';
  if (task.input && Object.keys(task.input).length > 0) {
    prompt += '\n## Provided Input Files\n\n';
    for (const [name, content] of Object.entries(task.input)) {
      const preview = content.length > 500 ? content.slice(0, 500) + '\n... (truncated)' : content;
      prompt += `### ${name}\n\`\`\`\n${preview}\n\`\`\`\n\n`;
    }
  }
  return prompt;
}

// ── CLI ──

function getArg(args, flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log(`MoltBench Evaluator — executable agent benchmark from MoltBook

Usage:
  node evaluator.mjs --stats                         Show statistics
  node evaluator.mjs --list [--cat <category>]       List tasks
  node evaluator.mjs --show <task_id>                Show prompt for a task
  node evaluator.mjs --setup <task_id> <work_dir>    Create input files
  node evaluator.mjs --eval <task_id> <work_dir>     Evaluate one completed task
  node evaluator.mjs --eval-all <results_dir>        Evaluate all (subdirs = task IDs)
  node evaluator.mjs --export-prompts <out_dir>      Export all prompts as .md files

Check types: file_exists, file_match, file_not_match, run, json_valid, line_count, file_count, word_count
Pass threshold: score >= 0.6 (configurable per task)`);
    return;
  }

  const tasks = loadTasks();

  // --stats
  if (args.includes('--stats')) {
    const cats = {}, diffs = {};
    for (const t of tasks) {
      cats[t.cat] = (cats[t.cat] || 0) + 1;
      diffs[t.diff] = (diffs[t.diff] || 0) + 1;
    }
    console.log(`MoltBench Statistics\n`);
    console.log(`Total tasks: ${tasks.length}`);
    console.log(`\nCategories:`);
    Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c.padEnd(15)} ${n}`));
    console.log(`\nDifficulty:`);
    Object.entries(diffs).forEach(([d, n]) => console.log(`  ${d.padEnd(10)} ${n}`));
    const withInput = tasks.filter(t => t.input && Object.keys(t.input).length > 0).length;
    const totalChecks = tasks.reduce((s, t) => s + (t.checks?.length || 0), 0);
    console.log(`\nTasks with input files: ${withInput}`);
    console.log(`Total evaluation checks: ${totalChecks} (avg ${(totalChecks / tasks.length).toFixed(1)} per task)`);
    const tags = {};
    for (const t of tasks) (t.tags || []).forEach(tag => tags[tag] = (tags[tag] || 0) + 1);
    const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`\nTop tags: ${topTags.map(([t, n]) => `${t}(${n})`).join(', ')}`);
    return;
  }

  // --list
  if (args.includes('--list')) {
    const catFilter = getArg(args, '--cat');
    const diffFilter = getArg(args, '--diff');
    let filtered = tasks;
    if (catFilter) filtered = filtered.filter(t => t.cat === catFilter);
    if (diffFilter) filtered = filtered.filter(t => t.diff === diffFilter);
    console.log(`${filtered.length} tasks:\n`);
    console.log('ID         Cat             Diff    Title');
    console.log('-'.repeat(75));
    for (const t of filtered) {
      console.log(`${t.id.padEnd(10)} ${t.cat.padEnd(15)} ${t.diff.padEnd(7)} ${t.title.slice(0, 45)}`);
    }
    return;
  }

  // --show
  if (args.includes('--show')) {
    const id = getArg(args, '--show');
    const task = tasks.find(t => t.id === id);
    if (!task) { console.error(`Task "${id}" not found.`); process.exit(1); }
    console.log(formatPrompt(task));
    return;
  }

  // --setup
  if (args.includes('--setup')) {
    const id = args[args.indexOf('--setup') + 1];
    const dir = args[args.indexOf('--setup') + 2];
    const task = tasks.find(t => t.id === id);
    if (!task) { console.error(`Task "${id}" not found.`); process.exit(1); }
    setupWorkspace(task, dir);
    console.log(`Workspace set up at ${dir} with ${Object.keys(task.input || {}).length} input files.`);
    return;
  }

  // --eval (single)
  if (args.includes('--eval') && !args.includes('--eval-all')) {
    const id = args[args.indexOf('--eval') + 1];
    const dir = args[args.indexOf('--eval') + 2];
    const task = tasks.find(t => t.id === id);
    if (!task) { console.error(`Task "${id}" not found.`); process.exit(1); }
    if (!fs.existsSync(dir)) { console.error(`Directory "${dir}" not found.`); process.exit(1); }

    const result = evaluate(task, dir);
    console.log(`Task: ${result.task_id} [${result.category}/${result.difficulty}]`);
    console.log(`Title: ${result.title}`);
    console.log(`\nChecks: ${result.checks_passed}/${result.checks_total}`);
    for (const c of result.checks) {
      const icon = c.passed ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${c.type}: ${c.path || c.cmd || ''}`);
    }
    console.log(`\nScore: ${(result.score * 100).toFixed(1)}%`);
    console.log(`Result: ${result.passed ? 'PASSED' : 'FAILED'}`);
    return;
  }

  // --eval-all
  if (args.includes('--eval-all')) {
    const dir = getArg(args, '--eval-all');
    if (!dir || !fs.existsSync(dir)) { console.error(`Directory not found: ${dir}`); process.exit(1); }

    const subdirs = fs.readdirSync(dir).filter(d => d.startsWith('mb-') && fs.statSync(path.join(dir, d)).isDirectory()).sort();
    if (subdirs.length === 0) { console.error('No mb-* subdirectories found.'); process.exit(1); }

    console.log(`Evaluating ${subdirs.length} tasks from ${dir}/\n`);
    const results = [];

    for (const sub of subdirs) {
      const task = tasks.find(t => t.id === sub);
      if (!task) { console.log(`  SKIP ${sub} (no matching task)`); continue; }
      const r = evaluate(task, path.join(dir, sub));
      results.push(r);
      console.log(`  ${r.task_id.padEnd(8)} [${r.category.padEnd(12)}] ${(r.score * 100).toFixed(0).padStart(3)}% ${r.passed ? 'PASS' : 'FAIL'} — ${r.title.slice(0, 40)}`);
    }

    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const mean = results.reduce((s, r) => s + r.score, 0) / total;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`RESULTS: ${passed}/${total} passed (${(100 * passed / total).toFixed(1)}%) | mean score ${(mean * 100).toFixed(1)}%`);

    const byCat = {};
    for (const r of results) {
      if (!byCat[r.category]) byCat[r.category] = { pass: 0, total: 0, sum: 0 };
      byCat[r.category].total++;
      byCat[r.category].sum += r.score;
      if (r.passed) byCat[r.category].pass++;
    }
    console.log(`\nBy category:`);
    for (const [cat, s] of Object.entries(byCat).sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${cat.padEnd(15)} ${s.pass}/${s.total} pass, mean ${(100 * s.sum / s.total).toFixed(0)}%`);
    }

    const outFile = path.join(dir, 'moltbench_results.json');
    fs.writeFileSync(outFile, JSON.stringify({ results, summary: { total, passed, mean_score: mean, by_category: byCat } }, null, 2));
    console.log(`\nDetailed results saved to ${outFile}`);
    return;
  }

  // --export-prompts
  if (args.includes('--export-prompts')) {
    const dir = getArg(args, '--export-prompts');
    fs.mkdirSync(dir, { recursive: true });
    for (const task of tasks) {
      fs.writeFileSync(path.join(dir, `${task.id}.md`), formatPrompt(task));
    }
    console.log(`Exported ${tasks.length} prompts to ${dir}/`);
    return;
  }

  console.error('Unknown command. Run with --help.');
  process.exit(1);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
