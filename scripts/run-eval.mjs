#!/usr/bin/env node
// Routing eval. Answers the only question that matters about a router:
// when someone states a real goal, does the right skill come back?
//
// This scores stage 1 (the deterministic coarse filter) only. Stage 2 is the
// model's fine ranking and is not measured here - but stage 1 sets the ceiling:
// a skill missing from the shortlist can never be planned.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml } from './lib/yaml-lite.mjs';
import { PLUGIN_ROOT, loadCatalog } from './lib/paths.mjs';

const CASES = path.join(PLUGIN_ROOT, 'eval', 'routing-cases.yaml');
const RETRIEVE = path.join(PLUGIN_ROOT, 'scripts', 'retrieve.mjs');

function retrieve(c, top) {
  const args = ['--goal', c.goal, '--top', String(top), '--json'];
  if (c.evidence) args.push('--evidence', c.evidence);
  if (c.product_line) args.push('--product-line', c.product_line);
  if (c.intent) args.push('--intent', c.intent);
  return JSON.parse(execFileSync('node', [RETRIEVE, ...args], { encoding: 'utf8', maxBuffer: 8 << 20 }));
}

function scoreCase(c, res) {
  const ids = res.candidates.map((x) => x.id);
  const top3 = ids.slice(0, 3);
  const top5 = ids.slice(0, 5);
  const prereqs = res.prerequisites.map((p) => p.id);
  const must = c.expect_must || [];
  const any = c.expect_any || [];
  const never = c.expect_never || [];
  const needPrereq = c.expect_prereq || [];

  const failures = [];

  const top1Applicable = must.length > 0;
  const top1Hit = top1Applicable && ids[0] === must[0];
  if (top1Applicable && !top1Hit) failures.push(`top1 is ${ids[0] || '(none)'}, expected ${must[0]}`);

  const missedTop3 = must.filter((m) => !top3.includes(m));
  if (missedTop3.length) {
    const where = missedTop3.map((m) => (ids.includes(m) ? `${m}@${ids.indexOf(m) + 1}` : `${m} absent`));
    failures.push(`not in top 3: ${where.join(', ')}`);
  }

  const anyOk = any.length === 0 || any.some((a) => top5.includes(a));
  if (!anyOk) failures.push(`none of expect_any in top 5: ${any.join(', ')}`);

  const leaked = never.filter((n) => ids.includes(n) || prereqs.includes(n));
  if (leaked.length) failures.push(`must never appear: ${leaked.join(', ')}`);

  const missedPrereq = needPrereq.filter((p) => !prereqs.includes(p) && !ids.includes(p));
  if (missedPrereq.length) failures.push(`prerequisite not inserted: ${missedPrereq.join(', ')}`);

  const signalApplicable = Boolean(c.expect_signal);
  const signalOk = !signalApplicable || res.signal === c.expect_signal;
  if (!signalOk) failures.push(`signal is '${res.signal}' (${(res.top1_concepts || []).join(', ') || 'no concepts'}), expected '${c.expect_signal}'`);

  return {
    id: c.id,
    goal: c.goal,
    ok: failures.length === 0,
    failures,
    ids,
    fallback: res.fallback,
    signal: res.signal,
    counts: {
      top1_applicable: top1Applicable ? 1 : 0,
      top1_hit: top1Hit ? 1 : 0,
      must_total: must.length,
      must_in_top3: must.length - missedTop3.length,
      prereq_total: needPrereq.length,
      prereq_hit: needPrereq.length - missedPrereq.length,
      never_total: never.length,
      never_leaked: leaked.length,
      signal_applicable: signalApplicable ? 1 : 0,
      signal_hit: signalApplicable && signalOk ? 1 : 0,
      fallback: res.fallback ? 1 : 0,
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const only = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : null;
  const top = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 12;

  const doc = parseYaml(fs.readFileSync(CASES, 'utf8'));
  const catalog = loadCatalog();
  const known = new Set(catalog.skills.map((s) => s.id));
  let cases = doc.cases || [];
  if (only) cases = cases.filter((c) => c.id === only);

  // The eval must be checked against the catalog too: a case that expects a
  // skill that no longer exists is a broken case, not a routing failure.
  const brokenCases = [];
  for (const c of cases) {
    for (const key of ['expect_must', 'expect_any', 'expect_never', 'expect_prereq']) {
      for (const id of c[key] || []) if (!known.has(id)) brokenCases.push(`${c.id}.${key}: '${id}' is not in the catalog`);
    }
  }

  const results = cases.map((c) => scoreCase(c, retrieve(c, top)));
  const sum = (k) => results.reduce((a, r) => a + r.counts[k], 0);

  const metrics = {
    cases: results.length,
    passed: results.filter((r) => r.ok).length,
    top1: sum('top1_applicable') ? sum('top1_hit') / sum('top1_applicable') : 1,
    top3_recall: sum('must_total') ? sum('must_in_top3') / sum('must_total') : 1,
    prereq: sum('prereq_total') ? sum('prereq_hit') / sum('prereq_total') : 1,
    wrong_line: sum('never_total') ? sum('never_leaked') / sum('never_total') : 0,
    signal: sum('signal_applicable') ? sum('signal_hit') / sum('signal_applicable') : 1,
    fallback_rate: results.length ? sum('fallback') / results.length : 0,
  };

  const th = doc.thresholds || {};
  const gates = [
    ['top1', metrics.top1, th.top1 ?? 0, 'min'],
    ['top3_recall', metrics.top3_recall, th.top3_recall ?? 0, 'min'],
    ['prereq', metrics.prereq, th.prereq ?? 0, 'min'],
    ['wrong_line', metrics.wrong_line, th.wrong_line ?? 1, 'max'],
    ['signal', metrics.signal, th.signal ?? 0, 'min'],
  ];
  const gateFailures = gates.filter(([, v, t, dir]) => (dir === 'min' ? v < t : v > t));
  const ok = gateFailures.length === 0 && brokenCases.length === 0;

  if (json) {
    console.log(JSON.stringify({ ok, metrics, gates, broken_cases: brokenCases, results }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${r.id}  ${r.goal.slice(0, 58)}`);
    if (!r.ok || verbose) {
      for (const f of r.failures) console.log(`       - ${f}`);
      if (verbose) console.log(`       top5: ${r.ids.slice(0, 5).join(', ')}`);
    }
  }
  if (brokenCases.length) {
    console.log('\nbroken cases (expectation references a skill not in the catalog):');
    for (const b of brokenCases) console.log(`  - ${b}`);
  }
  console.log('');
  console.log(`cases            ${metrics.passed}/${metrics.cases} fully clean`);
  for (const [name, value, threshold, dir] of gates) {
    const bad = dir === 'min' ? value < threshold : value > threshold;
    console.log(`${name.padEnd(16)} ${pct(value).padStart(6)}   ${dir === 'min' ? '>=' : '<='} ${pct(threshold)}  ${bad ? 'FAIL' : 'ok'}`);
  }
  console.log(`fallback_rate    ${pct(metrics.fallback_rate).padStart(6)}   (coarse filter found no keyword signal)`);
  console.log('');
  console.log(ok ? 'EVAL: pass' : 'EVAL: fail');
  process.exit(ok ? 0 : 1);
}

main();
