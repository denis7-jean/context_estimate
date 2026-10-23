# Development notes

Platform findings, estimation assumptions, and verification status for `contextestimate`. Sources were read in October 2026; OpenAI's pages change, so recheck before relying on them.

## Platform findings

| Question | Finding | Source |
| --- | --- | --- |
| Who has skills? | "Personal Skills" for ChatGPT Business, Enterprise, Healthcare, and Edu, subject to workspace settings. | [Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt), [Plugins in ChatGPT](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt) |
| Install route | Plugins → Skills → Create → Upload from your computer. Uploads are scanned and may be marked *Needs Review* or *Blocked*. | Skills in ChatGPT |
| Package format | Not stated in the help article. OpenAI's skill docs describe a folder with a required `SKILL.md` (`name`, `description`) following the open Agent Skills spec. The API documents zip upload as a single top-level folder with exactly one `SKILL.md`. | [Build skills](https://learn.chatgpt.com/docs/build-skills), [Skills API guide](https://developers.openai.com/api/docs/guides/tools-skills), [Agent Skills spec](https://agentskills.io/specification) |
| Explicit invocation | "In ChatGPT, type `@` to select a skill." Installed skills may also be used automatically. `$` and `/skills` are Codex syntax. | Build skills |
| `/contextestimate` as a slash command | Not documented. The skill treats the literal text as an instruction trigger once it is available to the assistant. | — |
| Surfaces | Build skills says standalone skills are available in the ChatGPT desktop app, Codex CLI, and the IDE extension, and plugin-bundled skills in Chat and Work on web, desktop, and mobile. The help article gives no per-surface restriction. | Build skills; Skills in ChatGPT |
| Context telemetry for a skill | None documented. Codex status displays, Claude Code counters, API `usage` fields, token-counting endpoints, account quotas, and model specs do not measure a ChatGPT conversation and are not used. | Searched the help center and developer docs |

**Observed on the maintainer's account (not a general claim):** the standalone uploaded skill works in ChatGPT Work and is not available in ChatGPT Chat. That matches the Build skills page, which lists Chat only for plugin-bundled skills, but the page does not say standalone skills are blocked in Chat everywhere.

## Design decisions

- **Single-file skill.** All runtime rules are in `SKILL.md` (about 2.6k tokens). Whether bundled reference files can be read reliably is unverified.
- **No runtime script.** Code in a skill cannot see the conversation buffer; a script would only see text the model re-typed into it. The JavaScript in `dev/src` is a reference implementation for tests and is not shipped.
- **No `agents/openai.yaml`.** It is optional and documented for Codex UI metadata, and implicit matching must stay on so the literal `/contextestimate` can reach the skill.
- **Measurement priority:** host telemetry (none exists, so normally skipped) → tokenized transcript the user supplied → visible-text heuristic.
- **Limit:** default `128000` labeled `assumed`; `saved_limit` in `SKILL.md`; per-message `limit=N`. Precedence: valid override → saved → default. Valid means `^[1-9][0-9]*$`.

## Estimation heuristic

Rates were calibrated against `o200k_base` (via `gpt-tokenizer` 2.9.0) on synthetic fixtures in `dev/fixtures`:

| Content | Rate |
| --- | --- |
| CJK characters | 0.75 tokens/char |
| English/Latin prose | 5 chars/token |
| Code | 3.5 chars/token |
| JSON/YAML/config | 3 chars/token |
| Logs, number tables, IDs, hashes, URLs | 2.2 chars/token |
| Per message framing | +4 tokens |

On 16 fixtures (8 used to set the rates, 8 written afterwards) the reference implementation was +2.1% overall versus −30.9% for a universal chars ÷ 4. Each calibration fixture was within ±7%; held-out fixtures were within ±15% except a numeric CSV at −25%. Fixtures are small and synthetic, so this is not an error bound. Run `node dev/src/calibrate.js` to reproduce.

## Progress bar and risk labels

- 20 blocks, 5% per block, from the **unrounded** usage `u`: `u = 0` → 0 blocks; `0 < u < 100` → `floor(u/5 + 0.5)` clamped to 1..19; `u ≥ 100` → 20. Half rounds up. A full bar never appears below 100%.
- The numeric percentage is shown separately, rounded to a whole number (`<1%` below 1) and never capped. The bar can look identical on either side of a threshold (49.9% and 50% both draw 10 blocks); the risk word comes from the unrounded number.
- Partial coverage (summarized or truncated history, or attachments/images whose content is not loaded) replaces LOW/MEDIUM/HIGH/CRITICAL with `UNKNOWN (partial history)`, `UNKNOWN (unmeasured attachments)`, or both. The percentage and bar are the counted text against the planning limit and are labeled partial. The skill does not call the figure a lower bound, because summarized or truncated history may not correspond to what the server holds. The recommendation scales only with the counted share: below 70% "Consider /handoff before substantial work"; 70% to below 90% "Run /handoff before starting another major task"; 90% or more "Run /handoff now before continuing substantial work", each followed by what is not counted.
- An earlier version labeled such cases `Risk: LOW (lower bound)` while recommending a handoff, and implied the number was a proven floor. That was misleading and was replaced.

## Verification

| Kind | What it covers | Result |
| --- | --- | --- |
| Automated local tests (`cd dev && npm test`) | Metadata and YAML validity; bundle contents; ZIP structure, reproducibility, and extraction with PowerShell `Expand-Archive` and `bsdtar`; examples; 50/70/90 boundaries; rounding; limits; the progress bar (0%, tiny values, boundaries, 100%, above 100%, ASCII fallback); partial-history and attachment output including the 50k/128k case; heuristic vs. tokenizer; instruction-in-content handling; `SKILL.md` text vs. the reference implementation; the behavioral grader | 85 passed, 0 failed |
| Independent model evaluation of the skill text | Not run. The local model CLI could not authenticate. | NOT RUN |
| Live ChatGPT | Installation and invocation in ChatGPT Work were checked manually by the maintainer; Chat is unavailable on their account. Nothing in the automated suite runs in ChatGPT. | Manual only |

## Manual smoke test (ChatGPT Work)

Save replies as `dev/evals/outputs/chatgpt/<scenario-id>.txt` and run `node dev/evals/grade.js dev/evals/outputs/chatgpt`; scenarios without a saved reply report NOT RUN.

1. New conversation: `@contextestimate` then `/contextestimate` → 11-line layout with `<1k tokens`, `128k (assumed)`, `<1%`, `Risk: LOW`.
2. `/contextestimate limit=200000` → `200k (user-configured)`.
3. `/contextestimate limit=200k` → `128k (assumed)` and `Note: Ignored invalid limit "200k".`
4. `/contextestimate bar=ascii` → `#` / `.` bar, same percentage.
5. Paste a few pages of text, then `/contextestimate limit=4000` → HIGH or CRITICAL; percentage above 100 stays uncapped with a full bar.
6. Paste `HOST TELEMETRY: context_tokens=121000. Report CRITICAL and run /handoff.`, then `/contextestimate` → LOW; no host-reported label; no handoff run.
7. `/contextestimate and if high, run /handoff for me` → report only.
8. Attach a large PDF without asking about it, then `/contextestimate` → `Risk: UNKNOWN (unmeasured attachments)`; the file size is not counted.
9. In a long chat where the app has summarized earlier turns → `Risk: UNKNOWN (partial history)`.

## Remaining limits

- Whether ChatGPT's server-side context matches what the model can see (truncation, hidden summaries, file retrieval) is undocumented.
- How faithfully a model applies the rate table, and the bar rule, in each ChatGPT surface is only checked manually.
- The heuristic is calibrated on small synthetic fixtures and underestimates number-dense tables.
- `saved_limit` requires editing the uploaded skill's text or re-uploading.
