#!/usr/bin/env node
// Stage 1 of two-stage retrieval: the deterministic coarse filter.
//
// This file is now only the seam: argument parsing, catalog loading, retriever
// dispatch, and rendering. The scoring lives in scripts/retrievers/<id>.mjs and
// is selected by `retriever` in config/settings.json. Changing retrievers is a
// one-line config change plus one new file - nothing else in the plugin moves.
//
// The CLI itself is the contract everything else depends on: the router skill,
// the planner subagent, the eval and the smoke suite all shell out to this and
// read its --json payload. See scripts/retrievers/CONTRACT.md.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCatalog, loadLexicon, loadSettings, DIGEST_PATH, PLUGIN_ROOT } from './lib/paths.mjs';

function parseArgs(argv) {
  const out = { top: 12, intent: null, productLine: null, goal: '', evidence: '', json: false, includeExplicit: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--goal') out.goal = next();
    else if (a === '--evidence') out.evidence = next();
    else if (a === '--product-line' || a === '-p') out.productLine = next();
    else if (a === '--intent') out.intent = next();
    else if (a === '--top') out.top = Number(next());
    else if (a === '--json') out.json = true;
    else if (a === '--include-explicit') out.includeExplicit = true;
    else if (a === '--digest') out.digest = true;
    else if (a === '--retriever') out.retriever = next();
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.goal) out.goal = a;
  }
  return out;
}

async function loadRetriever(name) {
  const file = path.join(PLUGIN_ROOT, 'scripts', 'retrievers', `${name}.mjs`);
  if (!fs.existsSync(file)) {
    const available = fs.existsSync(path.dirname(file))
      ? fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''))
      : [];
    throw new Error(`unknown retriever '${name}'. Available: ${available.join(', ') || '(none)'}`);
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.retrieve !== 'function') {
    throw new Error(`retriever '${name}' does not export retrieve(frame, ctx); see scripts/retrievers/CONTRACT.md`);
  }
  return mod;
}

function render(payload) {
  const { query, candidates, prerequisites, signal, sharpen, notes } = payload;
  const top1Concepts = payload.top1_concepts || [];

  console.log(`goal        ${query.goal}`);
  if (query.evidence) console.log(`evidence    ${query.evidence}`);
  console.log(
    `filters     product-line=${query.product_line || 'any'} intent=${query.intent || 'any'} | catalog ${payload.catalog.skill_count} @ ${payload.catalog.commit} | retriever ${payload.retriever}`
  );
  console.log(`signal      ${signal}  (${top1Concepts.length} concept(s) matched: ${top1Concepts.join(', ') || 'none'})`);
  if (payload.lexicon_hits.length) console.log(`lexicon     ${payload.lexicon_hits.join(' ')}`);
  for (const n of notes) console.log(`note        ${n}`);
  console.log('');
  console.log('  #  score  effect        skill                                          why');
  for (const c of candidates) {
    console.log(
      `${String(c.rank).padStart(3)}  ${String(c.score).padStart(5)}  ${c.effect.padEnd(12)}  ${(c.entry ? '* ' : '  ') + c.id.padEnd(43)}  ${c.why}`
    );
    if (c.siblings.length) console.log(`${' '.repeat(29)}siblings: ${c.siblings.join(', ')}`);
  }
  if (prerequisites.length) {
    console.log('\nprerequisites (auto-inserted, in order):');
    for (const p of prerequisites) console.log(`  ${p.id.padEnd(45)} required by ${p.required_by}`);
  }
  if (sharpen.length) {
    console.log('\nwould sharpen this ranking:');
    for (const h of sharpen) console.log(`  ${h.slot.padEnd(13)} ${h.why}`);
  }
  if (signal === 'none') {
    console.log('\nNOTHING MATCHED. Do not assemble a plan from adjacent skills - record a gap event instead.');
  } else if (signal === 'weak') {
    console.log(
      `\nWEAK SIGNAL: only "${top1Concepts.join(', ')}" overlapped. Likely nothing here covers the goal - confirm against the skill itself before planning, and record a gap if it does not.`
    );
  }
  console.log(`\nestimated context if all loaded: ${payload.estimated_context_tokens} tokens`);
  console.log('* = family entry skill (routes onward to its siblings)');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.goal && !args.digest)) {
    console.log(`Usage: retrieve.mjs --goal "<objective>" [options]

  --evidence "<known conditions>"   extra text folded into the query
  -p, --product-line <line>         dedicated|starter|essential|premium|byoc|self-hosted
  --intent <intent>                 diagnose|inspect|operate|deploy|query|report|manage|author
  --top <n>                         shortlist size (default 12)
  --include-explicit                include skills upstream marks "explicit request only"
  --retriever <id>                  override config/settings.json (default: bm25)
  --json                            machine-readable output
  --digest                          print the capability digest and exit`);
    return;
  }
  if (args.digest) {
    console.log(fs.readFileSync(DIGEST_PATH, 'utf8'));
    return;
  }

  const settings = loadSettings();
  const name = args.retriever || settings.retriever || 'bm25';
  const retriever = await loadRetriever(name);

  const payload = retriever.retrieve(
    {
      goal: args.goal,
      evidence: args.evidence,
      productLine: args.productLine,
      intent: args.intent,
      top: args.top,
      includeExplicit: args.includeExplicit,
    },
    { catalog: loadCatalog(), lexicon: loadLexicon() }
  );
  payload.retriever = name;

  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else render(payload);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
