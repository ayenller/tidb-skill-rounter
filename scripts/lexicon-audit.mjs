#!/usr/bin/env node
// Lexicon audit: which Chinese wording still reaches the retriever as noise.
//
// Upstream skill text is English; operators state goals in Chinese. Every
// Chinese phrase with no lexicon entry contributes nothing to scoring, and a
// goal made entirely of such phrases routes on the intent prior alone - right
// answer, no evidence (see eval case c43). This tool turns that invisible decay
// into a review list.
//
// It never edits the lexicon. Deciding that 改造工作量 should map to something,
// or that it should map to nothing because no skill covers it, is a judgement
// about the skill catalog, not a string operation.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml } from './lib/yaml-lite.mjs';
import { loadLexicon, PLUGIN_ROOT } from './lib/paths.mjs';

const CJK = /[㐀-鿿豈-﫿]/;
const MIN_SEGMENT = 2;

// Grammatical filler carries no domain meaning, so its absence from the lexicon
// is correct rather than a gap. A segment made only of these characters is
// dropped before ranking.
const FILLER = new Set(
  ('的 了 着 过 和 与 或 把 被 给 对 从 向 到 在 是 有 个 些 这 那 此 其 它 他 她 我 你 们 么 什 怎 哪 吗 呢 吧 啊 嘛 '
    + '还 也 就 都 很 太 更 最 上 下 前 后 里 外 中 间 一 二 三 四 五 六 七 八 九 十 几 多 少 大 小 新 旧 好 坏 '
    + '想 要 看 做 去 来 帮 请 让 使 成 为 如 果 因 所 以 但 而 且 然 虽 即 便 可 能 会 应 该 需 求 先 再 又 只 '
    + '不 没 无 非 常 真 挺 加 及 等 各 每 任 何 说 讲 问 答 知 道 觉 得 认 估 计 概 差 基 本 现 目 前 当 '
    + '近 刚 才 昨 今 明 晚 早 午 时 候 点 分 秒 次 遍 回 件 情 况 题 事 东 西 方 面 部 内 容 结 原 办 法 式 '
    + '掉 住 完 起 出 直 样 定 般 于 些 位 种 里 条 项 号 名 值 用 起')
    .split(/\s+/).filter(Boolean)
);
const isFiller = (seg) => [...seg].every((c) => FILLER.has(c));

function cjkRuns(text) {
  const runs = [];
  let cur = '';
  for (const ch of String(text)) {
    if (CJK.test(ch)) cur += ch;
    else { if (cur.length >= MIN_SEGMENT) runs.push(cur); cur = ''; }
  }
  if (cur.length >= MIN_SEGMENT) runs.push(cur);
  return runs;
}

// Mark the characters of a run that any lexicon key already covers, then return
// the maximal uncovered stretches of length >= MIN_SEGMENT.
function uncoveredSegments(run, terms) {
  const covered = new Array(run.length).fill(false);
  for (const term of terms) {
    if (term.length < MIN_SEGMENT) continue;
    let from = 0;
    for (;;) {
      const at = run.indexOf(term, from);
      if (at === -1) break;
      for (let i = at; i < at + term.length; i++) covered[i] = true;
      from = at + 1;
    }
  }
  const out = [];
  let cur = '';
  for (let i = 0; i < run.length; i++) {
    if (covered[i]) { if (cur.length >= MIN_SEGMENT) out.push(cur); cur = ''; }
    else cur += run[i];
  }
  if (cur.length >= MIN_SEGMENT) out.push(cur);
  return out;
}

function goalsFromEval() {
  const f = path.join(PLUGIN_ROOT, 'eval', 'routing-cases.yaml');
  if (!fs.existsSync(f)) return [];
  const doc = parseYaml(fs.readFileSync(f, 'utf8')) || {};
  return (doc.cases || []).map((c) => ({ source: `eval:${c.id}`, text: [c.goal, c.evidence].filter(Boolean).join(' ') }));
}

function goalsFromSessions() {
  const root = path.join(PLUGIN_ROOT, '.tidb-aio', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const f = path.join(root, id, 'trajectory.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'session_start' && e.data?.goal) out.push({ source: `session:${id}`, text: e.data.goal });
        if (e.type === 'gap' && e.data?.goal) out.push({ source: `gap:${id}`, text: e.data.goal });
      } catch { /* skip corrupt line */ }
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const from = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : 'both';

  const lexicon = loadLexicon();
  const terms = Object.keys(lexicon);
  const goals = [
    ...(from === 'sessions' ? [] : goalsFromEval()),
    ...(from === 'eval' ? [] : goalsFromSessions()),
  ];

  const uncovered = new Map(); // segment -> { count, sources: Set }
  const used = new Set();
  for (const g of goals) {
    for (const term of terms) if (g.text.includes(term)) used.add(term);
    for (const run of cjkRuns(g.text)) {
      for (const seg of uncoveredSegments(run, terms)) {
        const row = uncovered.get(seg) || { count: 0, sources: new Set() };
        row.count++;
        row.sources.add(g.source);
        uncovered.set(seg, row);
      }
    }
  }

  // Harm ranking: a missing phrase only matters if the goals containing it
  // actually retrieved weakly. A segment that appears exclusively in goals the
  // router already answers with strong evidence costs nothing.
  const signalOf = new Map();
  if (!argv.includes('--no-signal')) {
    const retrieveScript = path.join(PLUGIN_ROOT, 'scripts', 'retrieve.mjs');
    for (const g of goals) {
      try {
        const out = execFileSync('node', [retrieveScript, '--goal', g.text, '--top', '5', '--json'],
          { encoding: 'utf8', maxBuffer: 8 << 20 });
        signalOf.set(g.source, JSON.parse(out).signal);
      } catch { signalOf.set(g.source, 'unknown'); }
    }
  }

  const gaps = [...uncovered.entries()]
    .map(([segment, r]) => {
      const sources = [...r.sources];
      const harm = sources.filter((s) => ['weak', 'none'].includes(signalOf.get(s))).length;
      return { segment, count: r.count, harm, filler: isFiller(segment), sources };
    })
    .filter((g) => !g.filler)
    .sort((a, b) => b.harm - a.harm || b.count - a.count || a.segment.localeCompare(b.segment));
  const unused = terms.filter((t) => !used.has(t));

  if (json) {
    console.log(JSON.stringify({ goals: goals.length, terms: terms.length, used: used.size, gaps, unused }, null, 2));
    return;
  }

  const weakGoals = [...signalOf.values()].filter((v) => v !== 'strong').length;
  console.log(`corpus     ${goals.length} goals (${from})`);
  console.log(`lexicon    ${terms.length} terms, ${used.size} of them hit by this corpus`);
  if (signalOf.size) console.log(`retrieval  ${weakGoals}/${signalOf.size} goals scored weak or none`);
  console.log('');
  if (!gaps.length) {
    console.log('no uncovered Chinese segments - every phrase in the corpus maps to something');
  } else {
    const harmful = gaps.filter((g) => g.harm > 0);
    const shown = argv.includes('--all') ? gaps : harmful;
    console.log(`${gaps.length} unmapped Chinese segment(s); ${harmful.length} of them appear in goals that retrieved weakly:\n`);
    console.log('  harm  n  segment            seen in');
    for (const g of shown.slice(0, 30)) {
      console.log(`  ${String(g.harm).padStart(4)}  ${String(g.count).padStart(2)}  ${g.segment.padEnd(18)} ${g.sources.slice(0, 3).join(', ')}${g.sources.length > 3 ? ` +${g.sources.length - 3}` : ''}`);
    }
    if (shown.length > 30) console.log(`  ... ${shown.length - 30} more`);
    if (!argv.includes('--all')) console.log(`\n  (--all also lists the ${gaps.length - harmful.length} segments that cost nothing)`);
    console.log('');
    console.log('Three different things hide in this list. Sort them before editing anything:');
    console.log('  1. a Chinese word for something a skill\'s own text already says in English');
    console.log('     -> a real lexicon gap; add it to config/lexicon.yaml');
    console.log('  2. a word for something a skill DOES but its text never says');
    console.log('     -> a `subject` gap; add the English term to that skill in routing-overlay.yaml');
    console.log('  3. a phrase no skill covers at all');
    console.log('     -> leave it. Scoring zero is the router correctly reporting it does not');
    console.log('        know, and burying that under a lexicon entry is how a router starts');
    console.log('        confidently answering questions nobody can answer.');
  }
  if (unused.length) {
    console.log(`\n${unused.length} lexicon term(s) never hit by this corpus (harmless, but unverified):`);
    console.log(`  ${unused.join(' ')}`);
  }
}

main();
