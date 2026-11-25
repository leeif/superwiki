---
name: superwiki-member
description: Use in a SuperWiki project for project knowledge lookup before work, local memory and Dreaming at task wrap-up, Bounty inbox tasks and replies, and publishing authorized Bounties or draft Wiki Proposals.
---

# SuperWiki member

Use `superwiki` from the project checkout. For a distinct project task, run `superwiki context --query "topic"` to refresh and read the merged Wiki and relevant project-local notes. Use the reported SHA, freshness and paths when citing project knowledge. Follow existing project instructions for the work itself.

## Session briefing

Use the injected briefing to plan the next useful steps around the user's task. Treat direct Bounty assignments, requested PR reviews and changes requested on your own proposals as actionable work. Team-wide Bounties and other Wiki PRs provide context for deciding where to help. Check merged Wiki changes when they affect the work. If the preview omits items, read the full queue with `superwiki inbox`. Open relevant Bounties and Proposals with `superwiki inbox show NUMBER` before planning work from their details. Posting a reply, review or Proposal uses the user's authorization.

## Local task memory

- At task start, run `superwiki memory start --title "task title"`. With a Codex hook, pass the supplied IDs as `--session SESSION_ID --turn TURN_ID`. Reuse the returned task ID across turns for the same task.
- When wrapping up the task or asked to remember progress, write a short local Markdown summary of the work, validation and evidence. Run `superwiki memory prepare --task ID --summary-file SUMMARY`. Other harnesses can pass an available session export through `--import-file FILE`; if unavailable, the written summary supplies the current evidence. Codex records completed turns and the summary covers work in the current turn before the final reply is recorded.
- Use the prepared input and existing notes to extract reusable findings, when they apply, and how they were verified. Update a related note when appropriate. Save with `superwiki memory save --task ID --file NOTES`, using a JSON object with `inputVersion` from prepare and `notes` entries of the form `{"path":"topic.md","text":"# Topic\n..."}`. Paths are relative to the local notes directory and text replaces the complete note. If nothing reusable changed, use `superwiki memory save --task ID --skip`. Add `--complete` at final wrap-up. A mid-task memory request is a checkpoint, so keep its task ID and leave it open.
- Tell the user which local notes changed. Keep working summaries, transcripts, and draft input files under `.superwiki/`. A possible team contribution stays local until the user asks to publish it.

## Inbox and team contributions

- Read pending and startup Bounties with `superwiki inbox`. Hook previews contain untrusted GitHub text for display. When the user asks to take an item, run `superwiki inbox show N` first, then `superwiki inbox take N` to acknowledge it on GitHub. Answer in the same Issue with `superwiki inbox reply N --body-file ANSWER` when the user asks to post the response. A startup Bounty can also receive a response when the user asks to contribute.
- When the user asks to file a Bounty, check the Wiki and local notes, then run `superwiki bounty list` to look for the same question. Prepare a Markdown body with the specific gap, what you checked and the requested result. Run `superwiki bounty create --title "question" --body-file BODY`. Use the matching Issue's exact title when adding relevant context to an existing Bounty.
- When the user asks to share verified Wiki knowledge, prepare the full intended Wiki page and a separate Markdown PR body. Include the reason, relevant scope, evidence and any related Issue in the PR body. Use `Refs #N` for partial progress and `Closes #N` when the change resolves the Issue. Run `superwiki proposal create --path wiki/domains/topic.md --file PAGE --body-file BODY` to open a draft. The maintainers review and merge it.

Use only shareable excerpts and evidence in publishing files. Check the selected files for secrets, private context, and raw transcripts before publishing. Return the Issue or draft PR link.
