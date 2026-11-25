# SuperWiki

On this project, use the `superwiki-member` skill for project context, local memory, Bounties, and Proposals. Install it with `superwiki install --role member --harness codex` from this checkout, or use `--harness generic` and load the returned skill file in another harness. Run `superwiki doctor --role member` to check the installation.

For Codex, open the trusted project and review the installed hooks with `/hooks`. Trust them if you want local capture of your user messages and final assistant replies and automatic inbox previews. Keep `superwiki member run` in a project terminal to refresh the Wiki and your inbox.

Team knowledge comes from the merged default branch. Use `superwiki context --query "topic"` before starting a project task. Work in progress, transcripts and local notes stay under `.superwiki/`. Publish only the project information the user wants to share through the Issue and draft PR commands.
