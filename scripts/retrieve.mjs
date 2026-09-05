#!/usr/bin/env node
// Stage 1 of two-stage retrieval: a deterministic coarse filter.
//
// Its ONLY job is to guarantee the right skill is inside the shortlist while
// keeping the shortlist small enough to hand to the model for fine ranking.
// It must never be clever at the cost of recall, hence the zero-hit fallback.

import fs from 'node:fs';
import { loadCatalog, loadLexicon, DIGEST_PATH } from './lib/paths.mjs';

const FIELD_WEIGHTS = { name: 3, subject: 3, summary: 2, description: 1, category: 1 };
const STOP = new Set(('a an and are as at be by for from has how in is it its of on or that the to use used '
  + 'when with this these those you your we our i my via into over under between them they there here what '
  + 'which who why skill skills tidb cloud cluster').split(' '));

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
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.goal) out.goal = a;
  }
  return out;
}

function words(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9_+-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Chinese goals against English skill text: expand through the lexicon before
// tokenising, otherwise every score is 0 and we fall back for every query.
//
// `concepts` maps each resulting token back to what it came from. One Chinese
// word expanding into three English tokens is still ONE thing the operator
// said, and counting it as three is how "TiDB 换成 PostgreSQL 的迁移成本"
// scores as a confident match on a cost-inventory skill: 成本 -> cost finops
// inventory, three tokens, one concept, zero real overlap.
function expandQuery(text, lexicon) {
  const hits = [];
  const concepts = new Map();
  for (const w of words(text)) concepts.set(w, w);
  let expanded = text;
  for (const [term, english] of Object.entries(lexicon)) {
    if (text.includes(term)) {
      expanded += ' ' + english;
      hits.push(term);
      for (const w of words(english)) if (!concepts.has(w)) concepts.set(w, term);
    }
  }
  return { tokens: words(expanded), lexiconHits: hits, concepts };
}

function docFields(s) {
  return {
    name: s.name.replace(/-/g, ' ') + ' ' + s.name,
    subject: (s.subject || []).join(' ').replace(/-/g, ' '),
    summary: s.summary,
    description: s.description,
    category: s.category,
  };
}

function score(skill, qTokens, idf) {
  const fields = docFields(skill);
  let total = 0;
  const matched = new Set();
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const toks = words(fields[field]);
    if (!toks.length) continue;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const len = Math.max(toks.length, 1);
    for (const q of qTokens) {
      const f = tf.get(q);
      if (!f) continue;
      matched.add(q);
      // BM25-ish saturation, length-normalised per field.
      total += weight * (idf.get(q) || 0) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (len / 60))));
    }
  }
  return { total, matched: [...matched] };
}

function prereqClosure(selected, byId, productLine) {
  const out = [];
  const seen = new Set(selected.map((s) => s.id));
  const visit = (id) => {
    const s = byId.get(id);
    if (!s) return;
    const reqs = [...(s.requires || []), ...((s.requires_when || {})[productLine] || [])];
    for (const r of reqs) {
      if (seen.has(r)) continue;
      seen.add(r);
      visit(r);
      out.push({ id: r, required_by: id });
    }
  };
  for (const s of selected) visit(s.id);
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.goal && !args.digest)) {
    console.log(`Usage: retrieve.mjs --goal "<objective>" [options]

  --evidence "<known conditions>"   extra text folded into the query
  -p, --product-line <line>         dedicated|starter|essential|premium|byoc|self-hosted
  --intent <intent>                 diagnose|inspect|operate|deploy|query|report|manage|author
  --top <n>                         shortlist size (default 12)
  --include-explicit                include skills upstream marks "explicit request only"
  --json                            machine-readable output
  --digest                          print the capability digest and exit`);
    return;
  }
  if (args.digest) {
    console.log(fs.readFileSync(DIGEST_PATH, 'utf8'));
    return;
  }

  const catalog = loadCatalog();
  const lexicon = loadLexicon();
  const byId = new Map(catalog.skills.map((s) => [s.id, s]));
  const query = `${args.goal} ${args.evidence}`.trim();
  const { tokens: qTokens, lexiconHits, concepts } = expandQuery(query, lexicon);

  // Candidate pool after hard filters.
  const notes = [];
  let pool = catalog.skills.filter((s) => s.role !== 'gate');
  if (args.productLine) {
    const before = pool.length;
    pool = pool.filter((s) => s.scope.includes('*') || s.scope.includes(args.productLine));
    notes.push(`product-line ${args.productLine}: dropped ${before - pool.length}`);
  }
  if (!args.includeExplicit) {
    const before = pool.length;
    pool = pool.filter((s) => !s.explicit_only || query.includes(s.name));
    notes.push(`explicit-only: dropped ${before - pool.length}`);
  }

  // idf over the filtered pool.
  const df = new Map();
  for (const s of pool) {
    const seen = new Set(words(Object.values(docFields(s)).join(' ')));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(pool.length, 1);
  const idf = new Map();
  for (const t of new Set(qTokens)) idf.set(t, Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5)));

  let scored = pool.map((s) => {
    const { total, matched } = score(s, qTokens, idf);
    // A stated intent is a strong signal: "pause this changefeed" and "why did
    // CDC panic TiKV" share vocabulary but want different skills. Reward the
    // match and actively penalise the mismatch, or the diagnosis handbooks -
    // which are numerous and keyword-rich - swamp every operate/manage query.
    const intentFactor = !args.intent ? 1 : s.intent.includes(args.intent) ? 1.6 : 0.65;
    const entryBoost = s.entry ? 1.05 : 1;
    return { skill: s, score: total * intentFactor * entryBoost, matched };
  });

  // Recall safety net: never return an empty or near-empty shortlist.
  let fallback = false;
  if (scored.filter((r) => r.score > 0).length < 3) {
    fallback = true;
    notes.push('zero-hit fallback: keyword match too weak, ranked by intent/entry prior instead');
    scored = scored.map((r) => ({
      ...r,
      score: r.score + (args.intent && r.skill.intent.includes(args.intent) ? 2 : 0) + (r.skill.entry ? 1 : 0),
    }));
  }
  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  scored = scored.filter((r) => r.score > 0);

  // Family collapse: upstream already ships entry skills that route onward, so
  // keep the entry plus the single best leaf and demote the rest to siblings.
  const takenFamily = new Map();
  const emitted = new Set();
  const results = [];
  const emit = (r) => {
    if (emitted.has(r.skill.id)) return;
    emitted.add(r.skill.id);
    results.push(r);
  };
  for (const r of scored) {
    if (emitted.has(r.skill.id)) continue;
    const fam = r.skill.family;
    if (!fam) { emit(r); continue; }
    const state = takenFamily.get(fam) || { kept: 0, siblings: [] };
    if (state.kept === 0) {
      // Leaf first, entry second. Operators name a symptom ("SIGSEGV in the
      // TiKV log"), and routing them through the family handbook every time
      // costs a whole hop. The entry still rides along right behind it as the
      // fallback when the leaf turns out to be the wrong guess.
      emit(r);
      state.kept++;
      const entry = catalog.skills.find((s) => s.family === fam && s.entry);
      if (entry && entry.id !== r.skill.id) {
        emit({ skill: entry, score: r.score * 0.99, matched: r.matched, promoted: `family entry for ${r.skill.id}` });
        state.kept++;
      }
    } else {
      state.siblings.push(r.skill.id);
    }
    takenFamily.set(fam, state);
  }
  for (const r of results) {
    const st = takenFamily.get(r.skill.family);
    if (st && st.siblings.length && r.skill.entry) r.siblings = st.siblings.filter((id) => !emitted.has(id));
  }

  const top = results.slice(0, args.top);
  // Padding from the fallback ranker has no keyword evidence behind it; it may
  // stay in the shortlist for the model to consider, but it must not drag its
  // prerequisites into the plan.
  const grounded = top.filter((r) => r.matched.length > 0);
  const prereqs = prereqClosure(grounded.map((r) => r.skill), byId, args.productLine);
  const contextCost = top.reduce((a, r) => a + r.skill.skill_tokens, 0)
    + prereqs.reduce((a, p) => a + (byId.get(p.id)?.skill_tokens || 0), 0);

  // Signal strength: how much of what the operator actually said overlaps the
  // top candidate. This is deliberately NOT called "coverage" - a strong signal
  // means keyword evidence exists, not that the skill answers the goal. That
  // judgement is the model's, in stage 2. What this buys is a floor: the router
  // must not claim a match when only one concept, or none, actually matched.
  const top1 = top[0];
  const top1Concepts = top1 ? [...new Set(top1.matched.map((t) => concepts.get(t) || t))] : [];
  const signal = fallback ? 'none' : top1Concepts.length <= 1 ? 'weak' : 'strong';
  const margin = top.length > 1 && top[0].score > 0
    ? Number(((top[0].score - top[1].score) / top[0].score).toFixed(2))
    : null;

  // Which missing slot would most change this ranking? Intake exists for
  // exactly these; without them the coarse filter demonstrably degrades.
  const sharpen = [];
  if (!args.productLine && top.some((r) => !r.skill.scope.includes('*'))) {
    sharpen.push({ slot: 'product_line', why: 'the shortlist mixes product-line-specific skills; naming the line filters and reorders it' });
  }
  if (!args.intent && new Set(top.flatMap((r) => r.skill.intent)).size >= 3) {
    sharpen.push({ slot: 'intent', why: 'candidates span diagnose/operate/inspect; stating the intent separates skills that share vocabulary' });
  }
  if (!args.evidence && signal !== 'strong') {
    sharpen.push({ slot: 'evidence', why: 'the goal alone matched too few terms; a symptom, error string or metric name would ground it' });
  }

  const payload = {
    query: { goal: args.goal, evidence: args.evidence, product_line: args.productLine, intent: args.intent },
    catalog: { commit: catalog.source.commit, skill_count: catalog.stats.skill_count },
    lexicon_hits: lexiconHits,
    fallback,
    signal,
    top1_concepts: top1Concepts,
    top1_score: top1 ? Number(top1.score.toFixed(2)) : 0,
    margin,
    sharpen,
    notes,
    candidates: top.map((r, i) => ({
      rank: i + 1,
      id: r.skill.id,
      path: r.skill.path,
      score: Number(r.score.toFixed(2)),
      why: r.promoted || `matched: ${r.matched.join(', ') || '(prior only)'}`,
      grounded: r.matched.length > 0,
      effect: r.skill.effect,
      scope: r.skill.scope,
      inputs: r.skill.inputs,
      entry: r.skill.entry,
      siblings: r.siblings || [],
      skill_tokens: r.skill.skill_tokens,
      summary: r.skill.summary,
    })),
    prerequisites: prereqs.map((p) => ({ ...p, path: byId.get(p.id).path, inputs: byId.get(p.id).inputs })),
    estimated_context_tokens: contextCost,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`goal        ${args.goal}`);
  if (args.evidence) console.log(`evidence    ${args.evidence}`);
  console.log(`filters     product-line=${args.productLine || 'any'} intent=${args.intent || 'any'} | catalog ${payload.catalog.skill_count} @ ${payload.catalog.commit}`);
  console.log(`signal      ${signal}  (${top1Concepts.length} concept(s) matched: ${top1Concepts.join(', ') || 'none'})`);
  if (lexiconHits.length) console.log(`lexicon     ${lexiconHits.join(' ')}`);
  for (const n of notes) console.log(`note        ${n}`);
  console.log('');
  console.log('  #  score  effect        skill                                          why');
  for (const c of payload.candidates) {
    console.log(
      `${String(c.rank).padStart(3)}  ${String(c.score).padStart(5)}  ${c.effect.padEnd(12)}  ${(c.entry ? '* ' : '  ') + c.id.padEnd(43)}  ${c.why}`
    );
    if (c.siblings.length) console.log(`${' '.repeat(29)}siblings: ${c.siblings.join(', ')}`);
  }
  if (payload.prerequisites.length) {
    console.log('\nprerequisites (auto-inserted, in order):');
    for (const p of payload.prerequisites) console.log(`  ${p.id.padEnd(45)} required by ${p.required_by}`);
  }
  if (sharpen.length) {
    console.log('\nwould sharpen this ranking:');
    for (const h of sharpen) console.log(`  ${h.slot.padEnd(13)} ${h.why}`);
  }
  if (signal === 'none') {
    console.log('\nNOTHING MATCHED. Do not assemble a plan from adjacent skills - record a gap event instead.');
  } else if (signal === 'weak') {
    console.log(`\nWEAK SIGNAL: only "${top1Concepts.join(', ')}" overlapped. Likely nothing here covers the goal - confirm against the skill itself before planning, and record a gap if it does not.`);
  }
  console.log(`\nestimated context if all loaded: ${payload.estimated_context_tokens} tokens`);
  console.log('* = family entry skill (routes onward to its siblings)');
}

main();
