.PHONY: sync catalog digest verify sessions replay gaps eval smoke clean

sync:      ## clone/update the nutshell-skills checkout
	@bash scripts/sync-source.sh

catalog:   ## rebuild catalog/catalog.json and catalog/digest.md
	@node scripts/build-catalog.mjs

digest:    ## print the capability digest
	@node scripts/retrieve.mjs --digest

verify:    ## verify a plan: make verify PLAN=path/to/plan.yaml
	@node scripts/verify-plan.mjs $(PLAN)

sessions:  ## list routing sessions
	@node scripts/trajectory.mjs list

replay:    ## readable trace of a session: make replay S=s_2026...
	@node scripts/trajectory.mjs replay $(S)

gaps:      ## goals no skill covered, across all sessions
	@node scripts/trajectory.mjs gaps

eval:      ## routing eval: top1 / top3 recall / prerequisites / wrong product line
	@node scripts/run-eval.mjs

smoke:     ## acceptance: catalog + routing + plan verification + trajectory + eval
	@bash scripts/smoke.sh

clean:
	@rm -rf catalog/catalog.json catalog/digest.md
