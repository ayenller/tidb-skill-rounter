#!/usr/bin/env node
// Append-only session log.
//
// DeepSeek Harness: "everything the model sees is written to the session log,
// including system prompts, thinking chains, tool calls and results, sub-agent
// scheduling, and every context injection", and recovery / fork / replay all
// share the same event stream. This is that stream, scoped to what this router
// controls: intake answers, the shortlist, the plan and its verdict, every
// SKILL.md injection, gate decisions, and step completions.
//
// Nothing here interprets TiDB. It records what happened so a later session -
// or a human reviewing a bad route - can see exactly why a skill was loaded.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_ROOT } from './lib/paths.mjs';

const ROOT = path.join(PLUGIN_ROOT, '.tidb-aio', 'sessions');

const EVENT_TYPES = new Set([
  'session_start', 'intake_question', 'intake_answer', 'catalog_query', 'candidate_set',
  'plan', 'plan_verdict', 'gate_decision', 'context_injection', 'tool_call',
  'step_done', 'branch', 'report', 'fork', 'gap', 'note',
]);

function sessionDir(id) { return path.join(ROOT, id); }
function logPath(id) { return path.join(sessionDir(id), 'trajectory.jsonl'); }

function readEvents(id) {
  const f = logPath(id);
  if (!fs.existsSync(f)) throw new Error(`no such session: ${id}`);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { return { seq: i, type: 'corrupt', raw: l }; }
  });
}

function appendEvent(id, event) {
  const f = logPath(id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const seq = fs.existsSync(f) ? readEvents(id).length : 0;
  const record = { ts: new Date().toISOString(), seq, ...event };
  fs.appendFileSync(f, JSON.stringify(record) + '\n');
  return record;
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `s_${stamp}_${crypto.randomBytes(2).toString('hex')}`;
}

function listSessions() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT)
    .filter((d) => fs.existsSync(logPath(d)))
    .map((id) => {
      const events = readEvents(id);
      const start = events.find((e) => e.type === 'session_start');
      const plan = [...events].reverse().find((e) => e.type === 'plan');
      const done = new Set(events.filter((e) => e.type === 'step_done').map((e) => e.step));
      const total = plan?.data?.steps?.length || 0;
      return {
        id,
        goal: start?.data?.goal || plan?.data?.goal || '(no goal)',
        events: events.length,
        progress: total ? `${done.size}/${total}` : '-',
        last: events[events.length - 1]?.ts || '',
        done: total > 0 && done.size >= total,
      };
    })
    .sort((a, b) => b.last.localeCompare(a.last));
}

function resumeState(id) {
  const events = readEvents(id);
  const start = events.find((e) => e.type === 'session_start');
  const plan = [...events].reverse().find((e) => e.type === 'plan');
  const verdict = [...events].reverse().find((e) => e.type === 'plan_verdict');
  const doneIds = new Set(events.filter((e) => e.type === 'step_done').map((e) => e.step));
  const steps = plan?.data?.steps || [];
  const next = steps.find((s) => !doneIds.has(s.id)) || null;
  const injected = events.filter((e) => e.type === 'context_injection');
  const branches = events.filter((e) => e.type === 'branch');
  return {
    id,
    goal: start?.data?.goal || plan?.data?.goal || null,
    product_line: plan?.data?.product_line || start?.data?.product_line || null,
    plan_id: plan?.data?.plan_id || null,
    verified: verdict?.data?.ok ?? null,
    steps,
    done: [...doneIds],
    next,
    injected_tokens: injected.reduce((a, e) => a + (e.data?.tokens || 0), 0),
    injected: injected.map((e) => e.source),
    branches: branches.map((e) => e.data),
    complete: steps.length > 0 && doneIds.size >= steps.length,
  };
}

function fork(id, atStep) {
  const events = readEvents(id);
  const cut = events.findIndex((e) => e.type === 'step_done' && e.step === atStep);
  if (cut === -1) throw new Error(`session ${id} has no completed step '${atStep}' to fork from`);
  const kept = events.slice(0, cut + 1);
  const child = newId();
  fs.mkdirSync(sessionDir(child), { recursive: true });
  fs.writeFileSync(logPath(child), kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  appendEvent(child, { type: 'fork', data: { from: id, at: atStep, kept_events: kept.length } });
  return { child, kept: kept.length };
}

// Replay: reconstruct a readable trace from the event stream alone. This is
// what makes a bad route reviewable - you see which skill was injected, why,
// what it cost, and what the step concluded, in order.
function replay(id) {
  const events = readEvents(id);
  const lines = [];
  let injected = 0;
  for (const e of events) {
    const t = e.ts?.slice(11, 19) || '--:--:--';
    const d = e.data || {};
    switch (e.type) {
      case 'session_start':
        lines.push(`${t}  START      ${d.goal || '(no goal)'}${d.product_line ? `  [${d.product_line}]` : ''}`);
        break;
      case 'intake_question': lines.push(`${t}  ASK        ${d.text || JSON.stringify(d)}`); break;
      case 'intake_answer':   lines.push(`${t}  SLOTS      ${JSON.stringify(d)}`); break;
      case 'catalog_query':   lines.push(`${t}  RETRIEVE   ${d.goal ? `"${d.goal}"` : ''} intent=${d.intent || '-'} line=${d.product_line || '-'}`); break;
      case 'candidate_set':
        lines.push(`${t}  SHORTLIST  ${(d.top || []).length} candidates${d.fallback ? ' (fallback)' : ''}: ${(d.top || []).slice(0, 5).join(', ')}`);
        break;
      case 'plan':
        lines.push(`${t}  PLAN       ${d.plan_id || ''} ${(d.steps || []).length} steps, read_only=${d.constraints?.read_only ?? '?'}`);
        for (const st of d.steps || []) lines.push(`             ${st.id}  ${st.skill}`);
        break;
      case 'plan_verdict':    lines.push(`${t}  VERIFY     ${d.ok ? 'pass' : `FAIL (${d.errors} errors)`}`); break;
      case 'gate_decision':   lines.push(`${t}  GATE       ${e.step || ''} ${d.effect} -> ${d.approved_by ? `approved by ${d.approved_by}` : d.decision || 'blocked'}`); break;
      case 'context_injection':
        injected += d.tokens || 0;
        lines.push(`${t}  LOAD       ${e.step || ''} ${e.source}  (${d.tokens || '?'} tok, running ${injected})  ${d.reason || ''}`);
        break;
      case 'tool_call':       lines.push(`${t}  TOOL       ${d.name || ''} ${JSON.stringify(d.args || {}).slice(0, 80)}`); break;
      case 'step_done':       lines.push(`${t}  DONE       ${e.step}  ${JSON.stringify(d).slice(0, 100)}`); break;
      case 'branch':          lines.push(`${t}  BRANCH     ${JSON.stringify(d)}`); break;
      case 'gap':             lines.push(`${t}  GAP        missing: ${d.missing || '?'}  closest: ${(d.closest || []).join(', ')}`); break;
      case 'report':          lines.push(`${t}  REPORT     ${(d.conclusion || JSON.stringify(d)).slice(0, 120)}`); break;
      case 'fork':            lines.push(`${t}  FORK       from ${d.from} at ${d.at}`); break;
      default:                lines.push(`${t}  ${e.type.toUpperCase().padEnd(10)} ${JSON.stringify(d).slice(0, 100)}`);
    }
  }
  lines.push('');
  lines.push(`${events.length} events, ${injected} tokens of skill content injected`);
  return lines.join('\n');
}

function collectGaps() {
  const rows = [];
  for (const s of listSessions()) {
    for (const e of readEvents(s.id).filter((x) => x.type === 'gap')) {
      rows.push({ session: s.id, ts: e.ts, goal: e.data?.goal || s.goal, ...e.data });
    }
  }
  return rows;
}

function usage() {
  console.log(`Usage: trajectory.mjs <command> [options]

  new --goal "<objective>" [--product-line <line>]
        start a session; prints the session id

  append --session <id> --type <type> [--step <sN>] [--source <path>] [--data '<json>']
        append one event. Types:
          ${[...EVENT_TYPES].join(' ')}

  list                            sessions, newest first
  show <id> [--type <t>] [--last <n>]     raw events
  replay <id>                     readable trace: what was loaded, why, at what cost
  resume <id>                     what was done, what is next
  fork <id> --at <sN>             branch a new session after a completed step
  gaps [--json]                   goals no skill covered, across all sessions

Sessions live in .tidb-aio/sessions/<id>/trajectory.jsonl (append-only).`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else out._.push(a);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '-h' || cmd === '--help') return usage();

  if (cmd === 'new') {
    const id = newId();
    appendEvent(id, {
      type: 'session_start',
      data: { goal: args.goal || null, product_line: args['product-line'] || null, cwd: process.cwd() },
    });
    console.log(id);
    return;
  }

  if (cmd === 'append') {
    if (!args.session) throw new Error('--session is required');
    if (!args.type) throw new Error('--type is required');
    if (!EVENT_TYPES.has(args.type)) throw new Error(`unknown event type '${args.type}'; expected one of: ${[...EVENT_TYPES].join(' ')}`);
    let data = null;
    if (args.data) {
      try { data = JSON.parse(args.data); } catch { data = { text: args.data }; }
    }
    const rec = appendEvent(args.session, {
      type: args.type,
      step: args.step || null,
      source: args.source || null,
      data,
    });
    console.log(`seq ${rec.seq} ${rec.type}${rec.step ? ` (${rec.step})` : ''}`);
    return;
  }

  if (cmd === 'list') {
    const rows = listSessions();
    if (!rows.length) return console.log('no sessions yet');
    for (const r of rows) {
      console.log(`${r.id}  ${r.progress.padStart(5)}  ${r.done ? 'done   ' : 'open   '}${r.goal.slice(0, 70)}`);
    }
    return;
  }

  if (cmd === 'show') {
    const id = args._[0];
    if (!id) throw new Error('session id is required');
    let events = readEvents(id);
    if (args.type) events = events.filter((e) => e.type === args.type);
    if (args.last) events = events.slice(-Number(args.last));
    for (const e of events) {
      const head = `${String(e.seq).padStart(3)}  ${e.ts?.slice(11, 19) || ''}  ${e.type.padEnd(18)}`;
      const tail = [e.step, e.source, e.data ? JSON.stringify(e.data).slice(0, 140) : null].filter(Boolean).join('  ');
      console.log(head + tail);
    }
    return;
  }

  if (cmd === 'replay') {
    const id = args._[0];
    if (!id) throw new Error('session id is required');
    console.log(replay(id));
    return;
  }

  if (cmd === 'gaps') {
    const rows = collectGaps();
    if (args.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log('no gaps recorded yet');
    console.log(`${rows.length} recorded gap(s) - each one is a requirement for a skill that does not exist yet:\n`);
    for (const r of rows) {
      console.log(`${r.ts?.slice(0, 10)}  ${r.session}`);
      console.log(`  goal     ${r.goal}`);
      console.log(`  missing  ${r.missing || '(unspecified)'}`);
      if (r.closest?.length) console.log(`  closest  ${r.closest.join(', ')}`);
      console.log('');
    }
    console.log('Draft one with the upstream finops/create-skill skill.');
    return;
  }

  if (cmd === 'resume') {
    const id = args._[0];
    if (!id) throw new Error('session id is required');
    const st = resumeState(id);
    console.log(`session   ${st.id}`);
    console.log(`goal      ${st.goal || '(none)'}`);
    console.log(`plan      ${st.plan_id || '(none)'} | product-line ${st.product_line || 'unset'} | verified ${st.verified === null ? 'never' : st.verified}`);
    console.log(`progress  ${st.done.length}/${st.steps.length} steps | ${st.injected_tokens} tokens injected across ${st.injected.length} skill loads`);
    if (st.branches.length) console.log(`branches  ${JSON.stringify(st.branches)}`);
    console.log('');
    for (const s of st.steps) {
      const mark = st.done.includes(s.id) ? 'x' : st.next && s.id === st.next.id ? '>' : ' ';
      console.log(`  [${mark}] ${s.id}  ${s.skill}${s.why ? `  - ${s.why}` : ''}`);
    }
    console.log('');
    if (st.complete) console.log('all steps complete; nothing to resume');
    else if (st.next) console.log(`resume at ${st.next.id}: load ${st.next.skill} and continue. Do not re-run completed steps.`);
    else console.log('no plan recorded yet; re-run intake and planning');
    return;
  }

  if (cmd === 'fork') {
    const id = args._[0];
    if (!id) throw new Error('session id is required');
    if (!args.at) throw new Error('--at <step> is required');
    const { child, kept } = fork(id, args.at);
    console.log(`${child}  (forked from ${id} after ${args.at}, ${kept} events carried over)`);
    return;
  }

  usage();
  process.exitCode = 2;
}

try {
  main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
