// Resolve where nutshell-skills lives, and where our own files live.
// Resolution order is deliberate: explicit env > explicit config > vendored
// cache > conventional home clone > reverse-lookup through an installed
// Claude skill symlink. Never guesses silently: --verbose prints the winner.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseYaml, parseYamlChecked } from './yaml-lite.mjs';

export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CATALOG_PATH = path.join(PLUGIN_ROOT, 'catalog', 'catalog.json');
export const DIGEST_PATH = path.join(PLUGIN_ROOT, 'catalog', 'digest.md');

function expand(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadSettings() {
  const f = path.join(PLUGIN_ROOT, 'config', 'settings.json');
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function looksLikeSource(dir) {
  return dir && fs.existsSync(path.join(dir, 'skills')) && fs.existsSync(path.join(dir, 'sync-skills.sh'));
}

function viaInstalledSymlink() {
  const skillsHome = path.join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(skillsHome)) return null;
  for (const entry of fs.readdirSync(skillsHome)) {
    const p = path.join(skillsHome, entry);
    let target;
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      target = fs.realpathSync(p); // skips broken links
    } catch { continue; }
    // <root>/skills/<category>/<name>
    const root = path.resolve(target, '..', '..', '..');
    if (looksLikeSource(root)) return root;
  }
  return null;
}

export function resolveSource({ required = true } = {}) {
  const settings = loadSettings();
  const candidates = [
    ['env NUTSHELL_SKILLS_PATH', expand(process.env.NUTSHELL_SKILLS_PATH)],
    ['config/settings.json nutshellPath', expand(settings.nutshellPath)],
    ['vendored .cache', path.join(PLUGIN_ROOT, '.cache', 'nutshell-skills')],
    ['~/nutshell-skills', path.join(os.homedir(), 'nutshell-skills')],
  ];
  for (const [origin, dir] of candidates) {
    if (looksLikeSource(dir)) return { root: dir, origin };
  }
  const linked = viaInstalledSymlink();
  if (linked) return { root: linked, origin: '~/.claude/skills symlink' };
  if (!required) return null;
  throw new Error(
    'nutshell-skills source not found. Run `make sync` (clones into .cache/), ' +
      'or set NUTSHELL_SKILLS_PATH, or set nutshellPath in config/settings.json.'
  );
}

let OVERLAY_WARNINGS = [];

export function loadOverlay() {
  const f = path.join(PLUGIN_ROOT, 'config', 'routing-overlay.yaml');
  if (!fs.existsSync(f)) return {};
  const { value, warnings } = parseYamlChecked(fs.readFileSync(f, 'utf8'));
  OVERLAY_WARNINGS = warnings;
  return (value && value.skills) || {};
}

export function overlayWarnings() {
  return OVERLAY_WARNINGS;
}

export function loadLexicon() {
  const f = path.join(PLUGIN_ROOT, 'config', 'lexicon.yaml');
  if (!fs.existsSync(f)) return {};
  const doc = parseYaml(fs.readFileSync(f, 'utf8')) || {};
  return doc.terms || {};
}

export function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error('catalog/catalog.json missing. Run `make catalog`.');
  }
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}
