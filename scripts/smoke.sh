#!/usr/bin/env bash
# M0 + M1 acceptance.
#
# M0: the catalog builds clean and both DESIGN.md walkthroughs route to the
#     expected skills with their prerequisites filled in.
# M1: the verifier rejects every plan failure mode it exists to catch, accepts
#     a correct one, and the trajectory survives a write/resume/fork round trip.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"
fail=0

pass() { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fail=1; }

check() { # check <label> <expected-substring>   (output on stdin)
    local label="$1" want="$2" out
    out="$(cat)"
    if grep -qF -- "${want}" <<<"${out}"; then pass "${label}"; else bad "${label} (missing: ${want})"; fi
}

verify_expect() { # verify_expect <label> <fixture> <pass|fail> [expected-substring]
    local label="$1" fixture="$2" want="$3" needle="${4:-}" out rc
    out="$(node scripts/verify-plan.mjs "${fixture}" 2>&1)"; rc=$?
    if [[ "${want}" == pass && ${rc} -ne 0 ]]; then bad "${label}: expected pass, verifier rejected it"; return; fi
    if [[ "${want}" == fail && ${rc} -eq 0 ]]; then bad "${label}: expected fail, verifier let it through"; return; fi
    if [[ -n "${needle}" ]] && ! grep -qF -- "${needle}" <<<"${out}"; then
        bad "${label}: wrong reason (missing: ${needle})"; return
    fi
    pass "${label}"
}

echo "build"
if node scripts/build-catalog.mjs; then pass "catalog builds clean"; else bad "catalog build reported problems"; fi

echo
echo "M0 case 1: Starter latency regression"
out1="$(node scripts/retrieve.mjs \
    --goal 'Starter 集群 P99 从 20ms 涨到 300ms，昨天下午开始变慢' \
    --evidence '无变更，TiKV gRPC duration 同步上涨' \
    --product-line starter --intent diagnose --top 8)"
check "routes to tidb-perf-diagnosis"        'diagnosis/tidb-perf-diagnosis'              <<<"${out1}"
check "routes to tikv-fast-tune"             'diagnosis/tikv-fast-tune'                   <<<"${out1}"
check "auto-inserts o11y-auth"               'platform/o11y-auth'                         <<<"${out1}"
check "auto-inserts serverless pool routing" 'platform/tidbcloud-serverless-pool-routing' <<<"${out1}"
if grep -q 'ru-limit-inspection' <<<"${out1}"; then bad "dedicated-only skill leaked into Starter shortlist"; else pass "dedicated-only skills filtered out"; fi

echo
echo "M0 case 2: TCOC changefeed lag ticket"
out2="$(node scripts/retrieve.mjs \
    --goal 'TCOC 上有个工单说 changefeed 同步延迟，判断要不要升级处理' \
    --product-line dedicated --top 6)"
check "routes to jira-api"                'platform/jira-api'                 <<<"${out2}"
check "routes to ticdc-health-inspection" 'diagnosis/ticdc-health-inspection' <<<"${out2}"
check "auto-inserts clinic-api"           'platform/clinic-api'               <<<"${out2}"

echo
echo "M0 case 3: recall fallback stays honest"
node scripts/retrieve.mjs --goal 'asdfgh qwerty zxcvbn' --top 5 \
    | check "flags the fallback" 'zero-hit fallback'

echo
echo "M1: plan verification"
verify_expect "accepts the walkthrough plan"      eval/fixtures/plan-good.yaml              pass
verify_expect "accepts a properly gated write"    eval/fixtures/plan-gated-write.yaml       pass
verify_expect "rejects a hallucinated skill id"   eval/fixtures/plan-hallucinated-skill.yaml fail "is not in the catalog"
verify_expect "rejects a missing prerequisite"    eval/fixtures/plan-missing-prereq.yaml    fail "requires 'platform/o11y-auth'"
verify_expect "rejects an ungated production write" eval/fixtures/plan-ungated-write.yaml   fail "no gate skill"
verify_expect "rejects the wrong product line"    eval/fixtures/plan-wrong-product-line.yaml fail "does not apply to starter"

echo
echo "M3: step-level effect narrowing"
verify_expect "accepts a justified narrowing"     eval/fixtures/plan-narrowed-ok.yaml          pass "narrowed write-nonprod -> read-only"
verify_expect "rejects narrowing a skill with no read-only surface" \
                                                  eval/fixtures/plan-narrowed-forbidden.yaml   fail "may be narrowed only to"
verify_expect "rejects an unjustified narrowing"  eval/fixtures/plan-narrowed-unjustified.yaml fail "needs an effect_justification"

echo
echo "M3: signal - knowing when it does not know"
node scripts/retrieve.mjs --goal '帮我订下周去北京的机票' --top 3 \
    | check "out-of-domain goal reports signal none" 'signal      none'
node scripts/retrieve.mjs --goal '评估把 TiDB 换成 PostgreSQL 的迁移成本和改造工作量' --top 3 \
    | check "plausible-but-uncovered goal reports weak" 'signal      weak'
node scripts/retrieve.mjs --goal 'changefeed 同步延迟' --top 5 \
    | check "missing product line surfaces a sharpen hint" 'product_line'

echo
echo "M1: trajectory round trip"
sid="$(node scripts/trajectory.mjs new --goal 'smoke: starter latency' --product-line starter)"
plan_json="$(node --input-type=module -e "
import fs from 'node:fs';
import { parseYaml } from './scripts/lib/yaml-lite.mjs';
console.log(JSON.stringify(parseYaml(fs.readFileSync('eval/fixtures/plan-good.yaml', 'utf8'))));")"
node scripts/trajectory.mjs append --session "${sid}" --type plan --data "${plan_json}" >/dev/null
node scripts/trajectory.mjs append --session "${sid}" --type plan_verdict --data '{"ok":true}' >/dev/null
node scripts/trajectory.mjs append --session "${sid}" --type context_injection --step s1 \
    --source skills/platform/o11y-auth/SKILL.md --data '{"tokens":1200}' >/dev/null
node scripts/trajectory.mjs append --session "${sid}" --type step_done --step s1 >/dev/null
resumed="$(node scripts/trajectory.mjs resume "${sid}")"
check "resume finds the next pending step" 'resume at s2' <<<"${resumed}"
check "resume counts injected context"     '1200 tokens injected' <<<"${resumed}"
forked="$(node scripts/trajectory.mjs fork "${sid}" --at s1 | awk '{print $1}')"
node scripts/trajectory.mjs resume "${forked}" | check "fork carries history forward" 'resume at s2'
if node scripts/trajectory.mjs append --session "${sid}" --type not_a_real_type >/dev/null 2>&1; then
    bad "trajectory accepted an unknown event type"
else
    pass "trajectory rejects unknown event types"
fi
rm -rf "${root}/.tidb-aio/sessions/${sid}" "${root}/.tidb-aio/sessions/${forked}"

echo
echo "M2: routing eval"
if node scripts/run-eval.mjs >/dev/null 2>&1; then
    pass "routing eval clears every threshold"
else
    bad "routing eval below threshold - run: node scripts/run-eval.mjs"
fi

echo
if [[ ${fail} -eq 0 ]]; then echo "smoke: PASS"; else echo "smoke: FAIL"; fi
exit ${fail}
