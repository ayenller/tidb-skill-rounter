#!/usr/bin/env node
// Build catalog/catalog.json + catalog/digest.md from upstream SKILL.md files.
//
// Hard rule from DESIGN.md: the catalog is GENERATED, never hand-written.
// Human input enters only through config/routing-overlay.yaml, or through an
// upstream `x-routing:` frontmatter block (which wins over the overlay).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontmatterChecked, parseYamlChecked, estTokens } from './lib/yaml-lite.mjs';
import { resolveSource, loadOverlay, overlayWarnings, loadSettings, PLUGIN_ROOT, CATALOG_PATH, DIGEST_PATH } from './lib/paths.mjs';

const PRODUCT_LINES = ['dedicated', 'starter', 'essential', 'premium', 'byoc', 'self-hosted'];
const INTENTS = ['diagnose', 'inspect', 'operate', 'deploy', 'query', 'report', 'manage', 'author'];

const SCOPE_HINTS = {
  dedicated: /\bdedicated\b/i,
  starter: /\b(starter|serverless)\b/i,
  essential: /\bessential\b/i,
  premium: /\bpremium\b/i,
  byoc: /\bbyoc\b/i,
  'self-hosted': /\b(on-prem|on-premises|self-hosted|tiup|playground|local)\b/i,
};

const INTENT_HINTS = {
  diagnose: /\b(diagnos|troubleshoot|investigat|triage|root cause|why)/i,
  inspect: /\b(inspect|health check|audit|evaluat)/i,
  operate: /\b(operat|manage|pause|resume|restart|scale|execute)/i,
  deploy: /\b(deploy|destroy|provision|bootstrap|install)/i,
  query: /\b(query|fetch|read|list|retriev|access|api)/i,
  report: /\b(report|summar|digest|dashboard|rca)/i,
  manage: /\b(create|update|delete|manage|configure)/i,
  author: /\b(author|guardrail|write a skill|skill.md)/i,
};

function walkSkills(root) {
  const base = path.join(root, 'skills');
  const found = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(p, 'SKILL.md'))) found.push(p);
      visit(p);
    }
  };
  visit(base);
  // A skill directory may itself contain sub-skill directories; only the
  // outermost SKILL.md is a catalog entry. Sub-skills are reached through it.
  return found.filter((p) => !found.some((q) => q !== p && p.startsWith(q + path.sep)));
}

function firstSentence(text, cap = 170) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.{20,}?[.。!?])(\s|$)/);
  const s = m ? m[1] : flat;
  return s.length > cap ? s.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…' : s;
}

function bundleTokens(dir) {
  let total = 0;
  let files = 0;
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (/\.(md|markdown)$/i.test(e.name)) {
        total += estTokens(fs.readFileSync(p, 'utf8'));
        files++;
      }
    }
  };
  visit(dir);
  return { bundle_tokens: total, bundle_files: files };
}

function infer(list, hints, text) {
  const hit = list.filter((k) => hints[k]?.test(text));
  return hit;
}

function build() {
  const problems0 = [];
  const { root, origin } = resolveSource();
  const overlay = loadOverlay();
  for (const w of overlayWarnings()) problems0.push(`routing-overlay.yaml ${w}`);
  const settings = loadSettings();
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { /* source may not be a git checkout */ }

  const dirs = walkSkills(root).sort();
  const skills = [];
  const problems = [...problems0];
  const warnings = [];
  const seenOverlay = new Set();

  for (const dir of dirs) {
    const id = path.relative(path.join(root, 'skills'), dir).split(path.sep).join('/');
    const file = path.join(dir, 'SKILL.md');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatterChecked(raw);
    if (!parsed) { problems.push(`${id}: unparseable frontmatter`); continue; }
    const fm = parsed.value;
    for (const w of parsed.warnings) problems.push(`${id}: frontmatter ${w}`);
    if (!fm.name) problems.push(`${id}: missing name`);
    if (!fm.description) problems.push(`${id}: missing description`);

    const description = String(fm.description || '').replace(/\s+/g, ' ').trim();
    const category = id.split('/')[0];
    const text = `${fm.name || id} ${description}`;

    const ov = { ...(overlay[id] || {}), ...(fm['x-routing'] || {}) };
    if (overlay[id]) seenOverlay.add(id);

    const inferredScope = infer(PRODUCT_LINES, SCOPE_HINTS, text);
    const scope = ov.scope || (inferredScope.length ? inferredScope : ['*']);
    const scopeSource = ov.scope ? 'overlay' : inferredScope.length ? 'inferred' : 'default';
    // A wrongly narrowed scope silently deletes a skill from a product line's
    // shortlist, and nothing downstream can tell. Inference is allowed to widen
    // (to '*') on its own but must be confirmed by hand to narrow.
    if (scopeSource === 'inferred') {
      warnings.push(`${id}: scope narrowed to ${scope.join('/')} by keyword inference; confirm it in routing-overlay.yaml`);
    }
    const intent = ov.intent || (infer(INTENTS, INTENT_HINTS, text).length
      ? infer(INTENTS, INTENT_HINTS, text) : ['query']);
    const entry = ov.entry ?? /^entry (skill|guide)|entry point/i.test(description);

    const summary = firstSentence(description);
    const { bundle_tokens, bundle_files } = bundleTokens(dir);

    skills.push({
      id,
      name: fm.name || path.basename(dir),
      path: `skills/${id}/SKILL.md`,
      category,
      summary,
      description,
      intent,
      scope,
      subject: ov.subject || [],
      requires: ov.requires || [],
      requires_when: ov.requires_when || {},
      inputs: ov.inputs || [],
      effect: ov.effect || 'write-prod',
      // The lowest effect a plan step may claim for this skill. Defaults to the
      // skill's own effect, i.e. no narrowing allowed. Opt in per skill, so a
      // model cannot invent permission to call a writing skill "read-only".
      effect_min: ov.effect_min || ov.effect || 'write-prod',
      entry,
      scope_source: scopeSource,
      family: ov.family || null,
      explicit_only: ov.explicit_only ?? false,
      role: ov.role || 'none',
      overlay: Boolean(overlay[id] || fm['x-routing']),
      digest_tokens: estTokens(`${fm.name} - ${summary}`),
      skill_tokens: estTokens(raw),
      bundle_tokens,
      bundle_files,
    });
  }

  // Orphan overlay ids are the classic "config layer rots" failure. Fail loud.
  const ids = new Set(skills.map((s) => s.id));
  for (const k of Object.keys(overlay)) if (!ids.has(k)) problems.push(`overlay: unknown skill id '${k}'`);
  for (const s of skills) {
    for (const r of s.requires) if (!ids.has(r)) problems.push(`${s.id}: requires unknown id '${r}'`);
    for (const [pl, reqs] of Object.entries(s.requires_when))
      for (const r of reqs) if (!ids.has(r)) problems.push(`${s.id}: requires_when.${pl} unknown id '${r}'`);
  }

  const byCategory = {};
  for (const s of skills) byCategory[s.category] = (byCategory[s.category] || 0) + 1;

  const catalog = {
    schema: 1,
    generated_at: new Date().toISOString(),
    source: { repo: settings.sourceRepo || 'tidbcloud/nutshell-skills', commit, path: root, origin },
    stats: {
      skill_count: skills.length,
      by_category: byCategory,
      overlay_covered: seenOverlay.size,
      digest_tokens_total: skills.reduce((a, s) => a + s.digest_tokens, 0),
      full_tokens_total: skills.reduce((a, s) => a + s.skill_tokens, 0),
      bundle_tokens_total: skills.reduce((a, s) => a + s.bundle_tokens, 0),
    },
    skills,
  };

  // The CI drift job diffs catalog/, so a rebuild that changed nothing must
  // produce a byte-identical file. Carry the previous timestamp forward when
  // the content is unchanged, otherwise every build is a spurious diff.
  let unchanged = false;
  if (fs.existsSync(CATALOG_PATH)) {
    try {
      const previous = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      const strip = (c) => JSON.stringify({ ...c, generated_at: null });
      if (strip(previous) === strip(catalog)) {
        catalog.generated_at = previous.generated_at;
        unchanged = true;
      }
    } catch { /* unreadable previous catalog: just overwrite it */ }
  }

  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(DIGEST_PATH, renderDigest(catalog));

  const rel = (p) => path.relative(PLUGIN_ROOT, p);
  console.log(`source     ${root}  (${origin}, ${commit})`);
  console.log(`skills     ${skills.length} across ${Object.keys(byCategory).length} categories`);
  console.log(`overlay    ${seenOverlay.size}/${skills.length} covered`);
  console.log(`context    digest ${catalog.stats.digest_tokens_total} tok  |  all SKILL.md ${catalog.stats.full_tokens_total} tok  |  with bundles ${catalog.stats.bundle_tokens_total} tok`);
  console.log(`wrote      ${rel(CATALOG_PATH)}, ${rel(DIGEST_PATH)}${unchanged ? '  (unchanged since last build)' : '  (CONTENT CHANGED)'}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
}

function renderDigest(catalog) {
  const lines = [
    '# nutshell-skills capability digest',
    '',
    `Generated ${catalog.generated_at} from ${catalog.source.repo}@${catalog.source.commit}.`,
    'Do not edit; run `make catalog`. Load a full SKILL.md only when the plan selects it.',
    '',
  ];
  const cats = Object.keys(catalog.stats.by_category).sort();
  for (const c of cats) {
    lines.push(`## ${c}`, '');
    for (const s of catalog.skills.filter((x) => x.category === c)) {
      const flags = [
        s.entry ? 'entry' : null,
        s.effect !== 'read-only' ? s.effect : null,
        s.explicit_only ? 'explicit-only' : null,
        s.scope.includes('*') ? null : s.scope.join('/'),
      ].filter(Boolean);
      lines.push(`- \`${s.id}\`${flags.length ? ` [${flags.join(', ')}]` : ''} — ${s.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

build();
