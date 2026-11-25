# SuperWiki MVP Implementation Plan

**Goal:** Run the approved SuperWiki workflow in a private GitHub validation project using a local member and Codex Curator.

**Architecture:** A Node CLI holds project state in `.superwiki/`. Git and GitHub hold the shared Wiki, issues, PRs and dispatch records. Codex handles memory extraction through a member skill and produces structured Curator decisions.

**Tech stack:** Node 24 ESM, Node test runner, Git, GitHub CLI, Codex CLI and TOML configuration.

**Spec:** `docs/superwiki-mvp-design.md`.

## Implementation and acceptance

- [x] Write independent regression tests for Wiki snapshots and project discovery, memory, harness events, and GitHub dispatch. Run the missing-implementation checks first.
- [x] Implement project and CLI entry points in `src/core.mjs` and `src/cli.mjs`. Pin readers to the fetched default-branch SHA. Bootstrap a new repo with tracked Wiki files and retryable seed issues.
- [x] Implement project memory in `src/memory.mjs`. Capture scoped turns, prepare a task input, save notes and checkpoint progress. Verify duplicate handling and search.
- [x] Package member and Curator skills, project templates, and Codex hooks in `assets/` and `src/harness.mjs`. Verify installation and hook payloads without modifying user-level hook configuration.
- [x] Implement Bounty, dispatch, inbox, Proposal and Curator commands in `src/github.mjs`. Verify action validation, stable markers and isolated draft PR creation.
- [x] Run `npm test` and install the packed CLI into a temporary local prefix. Initialize the private sandbox twice and verify one issue per seed. In a separate member checkout, verify real Codex skill/hook capture, a local memory round trip, signed-in Curator dispatch, member receipt and reply, and a Proposal reflected in the synchronized Wiki after merge.

## Acceptance evidence

- `npm test` passed 29 tests. The npm archive was installed into an isolated prefix. Both role installations and doctor checks succeeded.
- Private GitHub sandbox `leeif/superwiki-mvp-sandbox` bootstrapped from an empty repository. The two seed Bounties remained the same after repeated initialization and a native Codex member invocation using a scoped acceptance bridge.
- Local Codex Curator assigned Issue #1. The member checkout synchronized the assignment and posted the acknowledgment and evidence. Native Codex discovered the installed member skill and three project hooks. The hook CLI was verified with scoped lifecycle payloads and the real inbox cache. Local Dreaming saved a note that another CLI invocation retrieved.
- The Curator reviewed Proposal #3 and re-reviewed updated commits. PR #3 merged and GitHub closed Issue #1. A member polling process pulled the same merge SHA `59ac86cdcc63479818d431dc971cf08c79ef13f8` into the local Wiki. The member directory Issue #2 stays open.
- The member and Curator used independent checkouts with the same GitHub test identity. The member test's direct Windows shell was blocked, so the initial publication used the installed member CLI and the agent retried through the scoped bridge.
