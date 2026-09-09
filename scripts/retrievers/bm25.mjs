#!/usr/bin/env node
// BM25-ish keyword retriever: the default stage-1 coarse filter.
//
// Implements the retriever contract in scripts/retrievers/CONTRACT.md. It is
// deliberately dumb and deliberately over-inclusive: its only job is to keep
// the right skill inside the shortlist. The model does the fine ranking, and a
// skill missing from here can never be planned, so recall beats precision at
// every tie.
//
// Swapping this for a semantic retriever means writing another module with the
// same two exports. Nothing else in the plugin changes.

export const id = 'bm25';
export const describes = 'BM25-ish keyword scoring over name/subject/summary/description, with a bilingual lexicon, TiDB-domain synonym folding, and a zero-hit recall fallback';

const FIELD_WEIGHTS = { name: 3, subject: 3, summary: 2, description: 1, category: 1 };
const STOP = new Set(('a an and are as at be by for from has how in is it its of on or that the to use used '
  + 'when with this these those you your we our i my via into over under between them they there here what '
  + 'which who why skill skills tidb cloud cluster').split(' '));

// Domain synonyms: same-language equivalences specific to TiDB Cloud, as
// opposed to config/lexicon.yaml's Chinese-to-English translation. In TiDB
// Cloud a tenant IS an org - Ops Portal and growth reporting say "tenant",
// Clinic's own API parameter is "org_id" - and upstream skill text uses
// whichever word its author's API generation happened to use. Folding both to
// one canonical token means a query written with either word matches skill
// text written with either word. Kept deliberately narrow: this is a named
// fact about the domain, not a general synonym engine.
const SYNONYMS = {
  org: 'tenant', orgs: 'tenant', org_id: 'tenant', orgid: 'tenant',
  organization: 'tenant', organizations: 'tenant', organisation: 'tenant', organisations: 'tenant',
  tenant_id: 'tenant', tenantid: 'tenant',
};

function words(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9_+-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => SYNONYMS[w] || w);
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

export function retrieve(frame, { catalog, lexicon }) {
  const byId = new Map(catalog.skills.map((s) => [s.id, s]));
  const query = `${frame.goal} ${frame.evidence}`.trim();
  const { tokens: qTokens, lexiconHits, concepts } = expandQuery(query, lexicon);

  // Candidate pool after hard filters.
  const notes = [];
  let pool = catalog.skills.filter((s) => s.role !== 'gate');
  if (frame.productLine) {
    const before = pool.length;
    pool = pool.filter((s) => s.scope.includes('*') || s.scope.includes(frame.productLine));
    notes.push(`product-line ${frame.productLine}: dropped ${before - pool.length}`);
  }
  if (!frame.includeExplicit) {
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
    const intentFactor = !frame.intent ? 1 : s.intent.includes(frame.intent) ? 1.6 : 0.65;
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
      score: r.score + (frame.intent && r.skill.intent.includes(frame.intent) ? 2 : 0) + (r.skill.entry ? 1 : 0),
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

  const top = results.slice(0, frame.top);
  // Padding from the fallback ranker has no keyword evidence behind it; it may
  // stay in the shortlist for the model to consider, but it must not drag its
  // prerequisites into the plan.
  const grounded = top.filter((r) => r.matched.length > 0);
  const prereqs = prereqClosure(grounded.map((r) => r.skill), byId, frame.productLine);
  const contextCost = top.reduce((a, r) => a + r.skill.skill_tokens, 0)
    + prereqs.reduce((a, p) => a + (byId.get(p.id)?.skill_tokens || 0), 0);

  // Signal strength: how much of what the operator actually said overlaps the
  // top candidate. This is deliberately NOT called "coverage" - a strong signal
  // means keyword evidence exists, not that the skill answers the goal. That
  // judgement is the model's, in stage 2. What this buys is a floor: the router
  // must not claim a match when only one concept, or none, actually matched.
  const top1 = top[0];
  const top1Concepts = top1 ? [...new Set(top1.matched.map((t) => concepts.get(t) || t))] : [];
  // Bug fixed here: this used to read `fallback ? 'none' : ...`, conflating two
  // different questions. `fallback` means "fewer than 3 skills scored above
  // zero, so the shortlist was padded with intent/entry-prior picks" - a
  // statement about the POOL's breadth. `signal` is about whether TOP1
  // specifically has real evidence. A query that genuinely and correctly
  // matches only one or two skills triggers the pool-padding fallback while
  // top1 still has solid matches behind it - e.g. "which clusters and
  // changefeeds belong to this org" correctly hits platform/devops-api on the
  // tenant/org synonym, but only two other skills score above zero at all, so
  // fallback fires and used to stamp this as signal:'none' - actively telling
  // the router to distrust a good match. top1.matched is computed before
  // fallback padding runs either way, so it is always the honest source.
  const signal = top1Concepts.length === 0 ? 'none' : top1Concepts.length === 1 ? 'weak' : 'strong';
  const margin = top.length > 1 && top[0].score > 0
    ? Number(((top[0].score - top[1].score) / top[0].score).toFixed(2))
    : null;

  // Which missing slot would most change this ranking? Intake exists for
  // exactly these; without them the coarse filter demonstrably degrades.
  const sharpen = [];
  if (!frame.productLine && top.some((r) => !r.skill.scope.includes('*'))) {
    sharpen.push({ slot: 'product_line', why: 'the shortlist mixes product-line-specific skills; naming the line filters and reorders it' });
  }
  if (!frame.intent && new Set(top.flatMap((r) => r.skill.intent)).size >= 3) {
    sharpen.push({ slot: 'intent', why: 'candidates span diagnose/operate/inspect; stating the intent separates skills that share vocabulary' });
  }
  if (!frame.evidence && signal !== 'strong') {
    sharpen.push({ slot: 'evidence', why: 'the goal alone matched too few terms; a symptom, error string or metric name would ground it' });
  }

  const payload = {
    query: { goal: frame.goal, evidence: frame.evidence, product_line: frame.productLine, intent: frame.intent },
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

  return payload;
}
