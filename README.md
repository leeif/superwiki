# SuperWiki

SuperWiki connects project-local agent memory to a shared Wiki in a GitHub repository. Members use their own harness. A maintainer runs a local Codex CLI Curator to triage Bounties and review Proposals.

## Install

Install Node.js 24+, Git and GitHub CLI. Configure your Git commit identity with `git config --global user.name` and `git config --global user.email`, or set them on the project checkout. For Codex roles, install and sign in to Codex CLI. Build and install the CLI package from this project:

```powershell
npm ci
npm test
npm pack
npm install --global ./superwiki-0.1.4.tgz
superwiki --help
```

## Initialize a project

Create an empty GitHub repository with Issues enabled and sign in with `gh auth login`. Run the following commands with your own repository URL:

```powershell
superwiki project init --remote https://github.com/acme/payments.git --path ./payments --harness codex --seed-bounties
Set-Location ./payments
superwiki doctor --role member
superwiki member run
```

Initialization seeds the project Wiki and two Bounties for project setup knowledge and member profiles. It can be rerun with the same URL and path if an earlier run stopped partway.

## Attach an existing local project

Run from the source project's Git checkout. The URL identifies an already initialized SuperWiki repository. SuperWiki finds the local Git root from the current directory and installs the member role there.

```powershell
superwiki project attach --remote https://github.com/acme/team-wiki.git --harness codex
superwiki context
```

The binding and Git checkout for the Wiki live under the local project's ignored `.superwiki/` directory. The source repository keeps its own Git remote and branch. Use the bound Wiki for `context`, Bounties and Proposals. Codex hooks are installed in the source project's `.codex/hooks.json` and reviewed in `/hooks`.

## Join and work

Clone the project's GitHub repository. In the checkout, run `superwiki install --role member --harness codex` and `superwiki doctor --role member`. In Codex, inspect and trust the project's SuperWiki hooks using `/hooks`. The member skill is installed in the checkout. Use `--harness generic` for a harness where you will opt in to the skill and call the CLI from the project terminal.

Run `superwiki member run` in a separate terminal to refresh the Wiki and inbox, or use `superwiki member run --once` to refresh immediately. In your agent, try “Read the project Wiki and show my Bounties”, “Take #12”, or “Remember what we learned from this task”.

Trusted Codex hooks inject a session briefing with open Bounties, Wiki Proposals, requested reviews, and merged Wiki changes. At session start the hook refreshes the inbox and Wiki when the cached data is older than 15 seconds. On prompt submission it can refresh the inbox alone. A failed or slow request falls back to the last available snapshot. The agent uses the briefing to plan around the current task, `superwiki inbox` for the full queue, and `superwiki inbox show NUMBER` for Bounty or Proposal details. `superwiki inbox --with-wiki` returns the refreshed queue and Wiki snapshot information.

```powershell
superwiki context --query "Windows setup"
superwiki inbox
superwiki inbox show 12
superwiki inbox take 12
superwiki inbox reply 12 --body-file answer.md
superwiki proposal create --path wiki/domains/windows.md --file team-note.md --body-file proposal.md
```

The member skill prepares local notes after a completed task or a request to remember. Prepare versioned notes with `memory start`, `memory prepare` and `memory save`. Your project-local transcripts, notes and snapshots live under the ignored `.superwiki/` directory.

## Run a Curator

Use an independent checkout signed in to the GitHub account named by `project.curator_login` in the default branch's `superwiki.toml`. Run:

```powershell
superwiki install --role curator --harness codex
superwiki doctor --role curator
superwiki curator run-once --dry-run
superwiki curator run
```

The Curator polls the project's open Issues and PRs. It assigns Bounties via GitHub and publishes advisory reviews. The member keeps ownership of their harness and accepts incoming work. Repository maintainers review and merge proposed Wiki changes.

See the [MVP design](docs/superwiki-mvp-design.md) for the directory layout, memory triggers and cold-start workflow.
