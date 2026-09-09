# Retriever contract

Stage 1 of retrieval is replaceable. A retriever is one file,
`scripts/retrievers/<id>.mjs`, selected by `retriever` in `config/settings.json`
or by `--retriever <id>` on the command line.

Nothing else in the plugin knows which one is in use. The router skill, the
planner subagent, the eval and the smoke suite all shell out to
`scripts/retrieve.mjs` and read its `--json` payload.

## Exports

```js
export const id = 'bm25';
export const describes = 'one line, shown in errors and diagnostics';
export function retrieve(frame, { catalog, lexicon }) { /* returns payload */ }
```

`retrieve` must be synchronous or return a payload directly. If a retriever
needs I/O (an embeddings endpoint, a local index), it must do that work at
module load or maintain its own cache; see `embedding.mjs`.

## Input

```js
frame = {
  goal: string,             // the objective, verbatim, any language
  evidence: string,         // known conditions; may be ''
  productLine: string|null, // dedicated|starter|essential|premium|byoc|self-hosted
  intent: string|null,      // diagnose|inspect|operate|deploy|query|report|manage|author
  top: number,              // shortlist size
  includeExplicit: boolean, // include skills upstream marks "explicit request only"
}
```

`catalog` is the parsed `catalog/catalog.json`; `lexicon` is `config/lexicon.yaml`'s
`terms` map. A retriever may ignore the lexicon if it does not need one.

## Output

```js
{
  query: { goal, evidence, product_line, intent },
  catalog: { commit, skill_count },
  lexicon_hits: string[],
  fallback: boolean,          // true when the retriever had no real signal
  signal: 'strong'|'weak'|'none',
  top1_concepts: string[],    // distinct things the operator said that matched
  top1_score: number,
  margin: number|null,        // (top1 - top2) / top1
  sharpen: [{ slot, why }],   // which missing intake slot would change this ranking
  notes: string[],            // human-readable trace of the filters applied
  candidates: [{
    rank, id, path, score, why, effect, scope, inputs,
    entry, siblings, skill_tokens, summary, grounded,
  }],
  prerequisites: [{ id, required_by, path, inputs }],
  estimated_context_tokens: number,
}
```

## Obligations, not suggestions

1. **Recall over precision.** A skill missing from the shortlist can never be
   planned. When in doubt, include it and let stage 2 prune.
2. **Never return an empty shortlist silently.** If scoring produces nothing,
   fall back to a prior, set `fallback: true`, and say so in `notes`.
3. **`grounded: false`** marks a candidate with no real evidence behind it,
   present only as recall padding. Downstream drops these from prerequisite
   closure, so mark them honestly.
4. **`signal` is evidence strength, not correctness.** Count distinct concepts
   the operator expressed, not tokens: one word expanding into three synonyms is
   one concept. Overstating this is how a cost-inventory skill becomes a
   confident answer to a database migration question. It must also be computed
   from the top candidate's own matched evidence, never from a pool-breadth
   signal like "did I need to pad the shortlist" — a query that genuinely and
   correctly matches only one or two skills is not the same failure as a query
   that matches nothing, and conflating them (bm25.mjs did, once) tells the
   router to distrust a good match.
5. **Honour the hard filters.** `productLine` scope and `explicit_only` are not
   ranking hints; a skill outside the product line must not appear at all.
6. **Compute the prerequisite closure** from `requires` and
   `requires_when[productLine]`, topologically ordered, over grounded candidates
   only.
7. **Fold same-language domain synonyms, not just translations.**
   `config/lexicon.yaml` handles Chinese-to-English; it does not help a query
   that says "org" against catalog text that says "tenant" — same language, same
   meaning, different word, because upstream skills inherited whichever term
   their underlying API generation used. TiDB Cloud's own domain has at least
   one of these: **org and tenant are the same identifier.** A keyword retriever
   should canonicalize known domain synonyms before scoring (see `SYNONYMS` in
   `bm25.mjs`); an embedding retriever gets this closer to free but should still
   be checked against it — embeddings are not guaranteed to place a product's
   internal jargon pair as close as a human reading both API docs would.

## Verifying a new retriever

```bash
node scripts/run-eval.mjs --retriever <id>   # 43 cases, five gates
bash scripts/smoke.sh
```

A retriever that cannot clear the eval thresholds does not ship as the default.
