#!/usr/bin/env node
// Deterministic plan checker. The model proposes; this decides.
//
// DESIGN.md red line 3: never trust a skill id that came out of a language
// model. Everything checkable without judgement is checked here, so the agent
// cannot execute a plan that references a skill that does not exist, skips an
// auth prerequisite, writes to production under a read-only constraint, or
// blows the context budget.

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './lib/yaml-lite.mjs';
import { loadCatalog, loadSettings } from './lib/paths.mjs';

const ERROR = 'error';
const WARN = 'warn';
const EFFECT_RANK = { 'read-only': 0, 'write-nonprod': 1, 'write-prod': 2, destructive: 3 };

function loadPlan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.replace(/^﻿/, '').trimStart();
  return trimmed.startsWith('{') ? JSON.parse(trimmed) : parseYaml(raw);
}

function checkOrder(steps, add) {
  // Steps execute in file order; `needs` must point backwards. Anything else
  // is either a cycle or an ordering mistake, and both are caught here.
  const index = new Map(steps.map((s, i) => [s.id, i]));
  for (const [i, s] of steps.entries()) {
    for (const n of s.needs || []) {
      if (!index.has(n)) { add(ERROR, `step ${s.id}: needs unknown step '${n}'`); continue; }
      if (index.get(n) >= i) add(ERROR, `step ${s.id}: needs '${n}' which does not run earlier (cycle or wrong order)`);
    }
  }
}

export function verify(planFile) {
  const findings = [];
  const add = (level, message) => findings.push({ level, message });

  const catalog = loadCatalog();
  const settings = loadSettings();
  const byId = new Map(catalog.skills.map((s) => [s.id, s]));

  let plan;
  try {
    plan = loadPlan(planFile);
  } catch (e) {
    return { ok: false, findings: [{ level: ERROR, message: `cannot parse plan: ${e.message}` }], summary: null, plan: null };
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) add(ERROR, 'plan has no steps');
  if (!plan.goal) add(WARN, 'plan has no goal; the trajectory will be hard to read later');

  const productLine = plan.product_line || null;
  const readOnly = plan.constraints?.read_only ?? settings.defaults?.readOnly ?? true;
  const budget = {
    maxSteps: plan.budget?.max_steps ?? settings.budget?.maxSteps ?? 8,
    maxContextTokens: plan.budget?.max_context_tokens ?? settings.budget?.maxContextTokens ?? 60000,
  };

  // 1. every referenced skill must exist; step ids must be unique
  const seenStepIds = new Set();
  for (const s of steps) {
    if (!s.id) { add(ERROR, `step without an id: ${JSON.stringify(s).slice(0, 60)}`); continue; }
    if (seenStepIds.has(s.id)) add(ERROR, `duplicate step id '${s.id}'`);
    seenStepIds.add(s.id);
    if (!s.skill) { add(ERROR, `step ${s.id}: no skill`); continue; }
    if (!byId.has(s.skill)) {
      const leaf = String(s.skill).split('/').pop();
      const near = [...byId.keys()].filter((k) => leaf && k.includes(leaf)).slice(0, 3);
      add(ERROR, `step ${s.id}: skill '${s.skill}' is not in the catalog${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`);
    }
    if (!s.why) add(WARN, `step ${s.id}: no 'why'; a step nobody can justify is a step to cut`);
  }

  const known = steps.filter((s) => s.skill && byId.has(s.skill));
  const skillsInPlan = new Set(known.map((s) => s.skill));
  const positionOf = new Map();
  known.forEach((s, i) => { if (!positionOf.has(s.skill)) positionOf.set(s.skill, i); });
  known.forEach((s, i) => {
    if (known.findIndex((x) => x.skill === s.skill) !== i) add(WARN, `step ${s.id}: skill '${s.skill}' already appears earlier in the plan`);
  });

  // 2. ordering
  checkOrder(steps, add);

  // 3. prerequisite closure, product-line aware
  for (const [i, s] of known.entries()) {
    const skill = byId.get(s.skill);
    const reqs = [...(skill.requires || []), ...((skill.requires_when || {})[productLine] || [])];
    for (const r of reqs) {
      if (!skillsInPlan.has(r)) {
        add(ERROR, `step ${s.id}: '${s.skill}' requires '${r}', which is not in the plan`);
      } else if (positionOf.get(r) >= i) {
        add(ERROR, `step ${s.id}: prerequisite '${r}' must run before it, not after`);
      }
    }
    if (!productLine && Object.keys(skill.requires_when || {}).length) {
      add(WARN, `step ${s.id}: '${s.skill}' has product-line-dependent prerequisites but the plan sets no product_line`);
    }
  }

  // 4. product-line applicability - the "routed into the wrong product line" failure
  if (productLine) {
    for (const s of known) {
      const skill = byId.get(s.skill);
      if (!skill.scope.includes('*') && !skill.scope.includes(productLine)) {
        add(ERROR, `step ${s.id}: '${s.skill}' does not apply to ${productLine} (scope: ${skill.scope.join('/')})`);
      }
    }
  }

  // 5. effects vs constraints, and the security gate
  //
  // A skill's catalog `effect` is its capability envelope, not what one step
  // does with it: searching a Jira ticket writes nothing even though jira-api
  // can escalate. A step may therefore claim a narrower effect - but only down
  // to the floor the overlay opted that skill into, and only with a written
  // justification, and it is always surfaced for review.
  const effectOf = (s) => {
    const skill = byId.get(s.skill);
    if (!s.effect || s.effect === skill.effect) return skill.effect;
    if (EFFECT_RANK[s.effect] === undefined) {
      add(ERROR, `step ${s.id}: unknown effect '${s.effect}'`);
      return skill.effect;
    }
    if (EFFECT_RANK[s.effect] > EFFECT_RANK[skill.effect]) {
      add(ERROR, `step ${s.id}: cannot claim '${s.effect}', wider than the skill's own '${skill.effect}'`);
      return skill.effect;
    }
    if (EFFECT_RANK[s.effect] < EFFECT_RANK[skill.effect_min]) {
      add(ERROR, `step ${s.id}: '${s.skill}' may be narrowed only to '${skill.effect_min}', not '${s.effect}'; if that is wrong, change effect_min in routing-overlay.yaml with a reason`);
      return skill.effect;
    }
    if (!s.effect_justification || String(s.effect_justification).trim().length < 20) {
      add(ERROR, `step ${s.id}: narrowing ${skill.effect} to ${s.effect} needs an effect_justification saying which read-only operation it uses`);
      return skill.effect;
    }
    add(WARN, `step ${s.id}: '${s.skill}' narrowed ${skill.effect} -> ${s.effect}: ${s.effect_justification}`);
    return s.effect;
  };

  // Resolve each step's effect exactly once: effectOf() records findings, and a
  // rejected override must not leak back into the summary as if it had stood.
  const stepEffect = new Map(known.map((s) => [s.id, effectOf(s)]));
  const isGate = (s) => byId.get(s.skill).role === 'gate';
  const writing = known.filter((s) => stepEffect.get(s.id) !== 'read-only' && !isGate(s));
  if (readOnly) {
    for (const s of writing) {
      add(ERROR, `step ${s.id}: '${s.skill}' is ${byId.get(s.skill).effect} but the plan is read_only; narrow the step with effect + effect_justification if it only reads, otherwise move it to manual_actions`);
    }
  }
  for (const s of known) {
    if (byId.get(s.skill).effect === 'destructive') {
      add(ERROR, `step ${s.id}: '${s.skill}' is destructive and must never be planned for execution`);
    }
  }
  if (!readOnly && writing.length) {
    const gateAt = known.findIndex(isGate);
    const firstWriteAt = known.findIndex((s) => writing.includes(s));
    if (gateAt === -1) {
      add(ERROR, `plan has ${writing.length} writing step(s) but no gate skill; add the security skill before the first write`);
    } else if (gateAt > firstWriteAt) {
      add(ERROR, 'the gate skill must run before the first writing step');
    }
  }

  // 6. explicit-only skills
  for (const s of known) {
    const skill = byId.get(s.skill);
    if (skill.explicit_only && !String(plan.goal || '').includes(skill.name)) {
      add(WARN, `step ${s.id}: '${s.skill}' is marked explicit-only upstream; include it only if the user named it`);
    }
  }

  // 7. budget
  const contextTokens = known.reduce((a, s) => a + byId.get(s.skill).skill_tokens, 0);
  if (steps.length > budget.maxSteps) {
    add(ERROR, `plan has ${steps.length} steps, budget is ${budget.maxSteps}; cut steps rather than truncating skills`);
  }
  if (contextTokens > budget.maxContextTokens) {
    add(ERROR, `plan would inject ~${contextTokens} tokens, budget is ${budget.maxContextTokens}`);
  }

  const errors = findings.filter((f) => f.level === ERROR);
  return {
    ok: errors.length === 0,
    findings,
    summary: {
      plan_id: plan.plan_id || null,
      goal: plan.goal || null,
      product_line: productLine,
      read_only: readOnly,
      steps: steps.length,
      context_tokens: contextTokens,
      max_effect: known.reduce(
        (a, s) => (EFFECT_RANK[stepEffect.get(s.id)] > EFFECT_RANK[a] ? stepEffect.get(s.id) : a),
        'read-only'
      ),
      narrowed: known
        .filter((s) => stepEffect.get(s.id) !== byId.get(s.skill).effect)
        .map((s) => `${s.id}:${byId.get(s.skill).effect}->${stepEffect.get(s.id)}`),
      errors: errors.length,
      warnings: findings.length - errors.length,
    },
    plan,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.log('Usage: verify-plan.mjs <plan.yaml|plan.json> [--json]');
    process.exit(2);
  }
  const result = verify(path.resolve(file));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = result.summary;
    if (s) {
      console.log(`plan     ${s.plan_id || '(no id)'} - ${s.goal || '(no goal)'}`);
      console.log(`shape    ${s.steps} steps | product-line ${s.product_line || 'unset'} | read_only ${s.read_only} | max effect ${s.max_effect} | ~${s.context_tokens} tok`);
      console.log('');
    }
    for (const f of result.findings) console.log(`${f.level === ERROR ? 'ERROR' : 'warn '}  ${f.message}`);
    if (!result.findings.length) console.log('no findings');
    console.log('');
    console.log(result.ok ? 'VERDICT: pass - safe to execute' : 'VERDICT: fail - re-plan, do not execute');
  }
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
