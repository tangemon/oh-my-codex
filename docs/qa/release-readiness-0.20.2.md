# Release readiness — 0.20.2

## Pre-tag readiness record

This record binds the `0.20.2` release candidate to the frozen upstream base and the release-preparation changes listed below. Local verification was executed on 2026-07-16 with `TMPDIR=/private/tmp` to use macOS's canonical temporary-directory path. CI, tag, GitHub release, npm publication, and public-install evidence remain pending until those events occur.

## Release identity

- Release: `0.20.2` (patch).
- Date: 2026-07-16.
- Previous tag: `v0.20.1`.
- Frozen dev base: `f5e4753135ebc86342e7353300ac3ec5d9ae3d8d`.
- Exact compare range: `v0.20.1..f5e4753135ebc86342e7353300ac3ec5d9ae3d8d`.
- Expected range inventory: 22 commits — 20 merged PRs, one release-development preparation commit, and the direct-branch plus merge commits for #3129 release collateral.
- Compatibility: no intentional breaking CLI or package-layout changes.

## Frozen commit inventory

| Commit | PR / classification | Release disposition |
|---|---|---|
| `c628486896ffa8b9188335b91a76192571e32c9d` | Direct branch commit for #3129; release collateral | 0.20.1 evidence reconciliation; inventory only. |
| `fce27bfd6c17c7665a6f1505b6b8384cc2c8edd5` | Merge commit for #3129; release collateral | Promoted 0.20.1 evidence reconciliation; inventory only. |
| `29bdeb5c5670c133d9f2feda7512ee01e80a63d5` | Direct commit; release preparation | Started 0.20.2 development/version synchronization; not a product headline. |
| `93eda27d9ec2a52ba0f563f75073c248357ad0c8` | #3136 | Explicit Team worker policy. |
| `2a633a3939e63be2d356dd65016890bb7b0995ea` | #3158 | Canonical Ralplan session state. |
| `90601c96fca7a69bd65c25e0b66316e188672eb0` | #3155; dependency | TypeScript 6.0.3 → 7.0.2. |
| `c5f03c3498186bee4d6a97099a43435889ede428` | #3154; dependency | `actions/setup-node` 6 → 7. |
| `d6e0349f5aed7ce4702c6c1dbb22190f16862fdf` | #3157; dependency | `@biomejs/biome` 2.5.2 → 2.5.3. |
| `9f4f8f09bd2f098c4cbe56ae4798dfbfb7085666` | #3156; dependency | `@types/node` 26.1.0 → 26.1.1. |
| `24a991d6bbe3b7e02eac3fb947d8f585d19aeac8` | #3164; issue #3163 | Persistent explicit setup `AGENTS.md` merge policy. |
| `e87d05a8037c9a6fef32b2a1aee307d57383e75c` | #3165; issue #3162 | Cross-process fallback notification dedupe. |
| `bb37005b4a0a4b12c8b6d48db6fc704debb9506f` | #3152; issue #3118 | Surface-aware native-subagent role contract. |
| `e6b0509533039e4467f53699b7ad4e74492e7f59` | #3168 | Concurrent-chat prompt session provenance isolation. |
| `e8e9467804a73cba0c982b3ed99a0ce8b6843d2c` | #3169 | BOM-prefixed state input support. |
| `4e57bf33bf97e0c03c6ecf57ba4b504b633df33d` | #3172 | Foreign stale transition-mirror rejection. |
| `91289b2eedb2d3eea77e23e0411137d4a7bb418f` | #3151 | Foreign Codex hook-coordinate preservation. |
| `8a997dc0bcdb6820e24f967f33867887ede38322` | #3166; issue #3118 | Transactional adapted binding and lock-artifact cleanup. |
| `3532caacbe3e24e2c529709b806b6d200766ac85` | #3179; issue #3177 | Authenticated deep-interview terminal write. |
| `1ee7fb6b022a049ec08eb40d31e792c125124768` | #3140; issue #3133 | Explicit workflow invocation requirement. |
| `69707f9cd6791b19d955b96a5dd91a48557e83e9` | #3180 | Native-subagent Stop behavior without auto-nudge. |
| `ce358f99c0ec54b96dbf5adcededb11620e42b24` | #3183; issue #3175 | tmux-owned detached-pane environment preservation. |
| `f5e4753135ebc86342e7353300ac3ec5d9ae3d8d` | #3184; issue #3181; frozen base | Authenticated App Ralplan leader bootstrap. |

The expected merged PR set is #3129, #3136, #3140, #3151, #3152, #3154, #3155, #3156, #3157, #3158, #3164, #3165, #3166, #3168, #3169, #3172, #3179, #3180, #3183, and #3184. Associated issues #3118, #3133, #3162, #3163, #3175, #3177, and #3181 are not additional PRs. Reproduce the inventory with:

```sh
git log --reverse --format='%H%x09%s' v0.20.1..f5e4753135ebc86342e7353300ac3ec5d9ae3d8d
```

Any mismatch blocks release preparation.

## Required gates

| Gate | Evidence | Status |
|---|---|---|
| Collateral/range review | Confirmed the frozen 22-commit range, all 20 merged PRs, classifications, highlights, contributors, and compare link across `CHANGELOG.md`, `docs/release-notes-0.20.2.md`, `RELEASE_BODY.md`, and this record. | Passed locally |
| Release-scope review | Candidate changes are the four release-collateral files plus six Darwin portability corrections in existing tests: doctor warning paths, resume `stat` portability/UTC, setup hook trust paths and installed-Codex boundary skips, and canonical adapted-role/tracker cwd expectations. Version metadata remains synchronized at `0.20.2`; no dependency, lockfile, workflow, or product-runtime source change is included. | Passed locally |
| Local quality gates | Passed: `npm run build`, `npm run build:full`, `npm run sync:plugin:check`, `npm run check:no-unused`, `npm run lint`, `npm test` (383 compiled test files), `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and `npm run smoke:packed-install`. The packed-install smoke used an isolated `@openai/codex@0.142.5` executable because the workstation default is 0.142.3. | Passed locally |
| Review | Required Ultragoal cleanup, architecture review, and executor QA/red-team receipts are pending against the final committed candidate tree. | Pending |
| CI | Record the `dev` and `main` CI run URLs, exact commits, conclusions, and required job results. | Pending |
| Tag and release | Record the annotated `v0.20.2` tag object/target and GitHub release URL after publication. | Pending |
| npm publication | Record package version, registry URL, integrity/package-install evidence, and publication result. | Pending |

No pending status may be interpreted as a pass. A failed gate blocks tag or publication; exceptions require an explicit maintainer decision and must not weaken the release contract.

## External evidence requirements

For each completed gate, retain an immutable receipt that identifies the frozen commit, command or review performed, timestamp, actor/system, outcome, and stable URL or artifact path where applicable. CI, tag, GitHub release, npm publication, and public-install evidence must be collected only after those events occur; this document intentionally supplies none.

## Release notes and contributors

The product-facing summary is in `docs/release-notes-0.20.2.md`, the GitHub body is `RELEASE_BODY.md`, and the changelog entry is `CHANGELOG.md`. Commit evidence identifies Bellman (@Yeachan-Heo), @cristph, @terwox, and @dependabot[bot]. The compare link is [`v0.20.1...v0.20.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.1...v0.20.2).
