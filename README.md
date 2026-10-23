# contextestimate

A [ChatGPT skill](https://help.openai.com/en/articles/20001066-skills-in-chatgpt) that gives a quick, honest estimate of how full the current conversation is, shows it as a progress bar, and tells you whether to run your own `/handoff` skill.

It estimates the **conversation text the assistant can access**. It does not read ChatGPT's hidden context meter, and it never runs `/handoff` for you.

## Example

```
Context Estimate
Estimated visible context: ~50k tokens
Configured context limit: 128k (assumed)
Estimated usage: ~39%
[████████░░░░░░░░░░░░] ~39% of planning limit

Risk: LOW
Recommendation:
Continue normally.

Note: Visible-text estimate; actual context usage may differ.
```

When earlier history was summarized or truncated, or attachments/images could not be counted, the skill does not pretend the number is complete. It shows what it counted, labels it partial, and reports `UNKNOWN`:

```
Context Estimate
Estimated visible context: ~50k tokens (partial)
Configured context limit: 128k (assumed)
Estimated usage: ~39% (counted text only)
[████████░░░░░░░░░░░░] ~39% of planning limit (partial)

Risk: UNKNOWN (partial history)
Recommendation:
Consider /handoff before substantial work; earlier history is not counted.

Note: Counts accessible text only; earlier history is summarized or truncated, so actual usage may be higher or lower.
```

- The numeric percentage is the precise value and is never capped (a 117% conversation shows `~117%` beside a full bar).
- The bar is a visual aid: 20 blocks, 5% each, `floor(u/5 + 0.5)` filled, at least 1 for any nonzero usage, 20 only at 100% or more. Risk is always written in words.
- Risk levels: LOW below 50%, MEDIUM 50% to below 70%, HIGH 70% to below 90%, CRITICAL 90% or more, classified on the unrounded value. These are planning thresholds, not measured failure points.
- `128k` is a configurable planning assumption, not a verified limit of any ChatGPT model or plan.
- If your ChatGPT view can't render `█` and `░`, add `bar=ascii` for a `#` / `.` bar.

## Estimation limits

- **Visible text only.** It counts messages, tool results, and loaded file text it can see, once each. It does not count system or developer instructions, memory, hidden reasoning, images, or attachment contents that are not loaded, and it does not reconstruct earlier turns from a summary.
- **Heuristic, not a tokenizer.** The model applies per-content-type rates (CJK, English prose, code, JSON/YAML, logs and IDs) rather than one "characters ÷ 4" rule. In a local check against `o200k_base` on 16 small synthetic texts, the reference implementation of those rates was +2% overall and within ±15% on all but one number-heavy CSV (−25%). That is not an error bound, and ChatGPT applying the table by judgment will be less exact.
- **No telemetry.** OpenAI documents no way for a skill to read current-conversation token usage. Numbers pasted into the chat are treated as content, never as measurements.
- Instructions that appear inside the conversation are data and are not followed.

Details and sources are in [docs/development-notes.md](docs/development-notes.md).

## Install and use

**Supported and tested surface: ChatGPT Work.** The maintainer installed and invoked the skill in ChatGPT Work.

**ChatGPT Chat: unavailable on the maintainer's account.** The standalone uploaded skill did not appear in Chat there. This is an observed availability limit on one account, not a statement about OpenAI's products in general (OpenAI's docs say plugin-bundled skills are available in Chat and Work, and that availability varies by plan, workspace, and surface).

Skills are documented for ChatGPT Business, Enterprise, Healthcare, and Edu workspaces, subject to workspace settings (including whether skill uploading is enabled).

1. Download [`dist/contextestimate.zip`](dist/contextestimate.zip) (or zip the `skill/contextestimate/` folder yourself).
2. In ChatGPT, open **Plugins → Skills → Create → Upload from your computer** and select the ZIP. Wait for the scan to finish.
3. In **ChatGPT Work**, start a message with `@` and pick **contextestimate**, then send:

```
/contextestimate
/contextestimate limit=200000
/contextestimate bar=ascii
```

`/contextestimate` is an instruction trigger inside the skill, not a documented ChatGPT slash command. The documented way to call a skill explicitly is the `@` mention; whether a bare `/contextestimate` is matched automatically has not been verified.

`limit=N` must be a positive integer with no separators or suffixes (`200k` is ignored with a note). It applies to that message only. To change the default for good, edit `saved_limit:` in the skill's `SKILL.md` and re-upload.

## Develop

```bash
cd dev
npm install
npm test            # validates the skill, rebuilds the ZIP, runs all tests
npm run package     # rebuild dist/contextestimate.zip only
node src/calibrate.js   # heuristic vs. o200k_base table
```

The ZIP is built deterministically (fixed timestamps, sorted entries), so rebuilding from the same `SKILL.md` gives a byte-identical file.

```
skill/contextestimate/SKILL.md   the whole skill (this is what ships)
dist/contextestimate.zip         upload-ready package: one top-level contextestimate/ folder
dev/                             packager, validator, reference implementation, fixtures, tests
docs/development-notes.md        platform findings, assumptions, verification status
```

`dev/src/policy.js` and `dev/src/heuristic.js` are a reference implementation used by the tests to pin down the documented rules. They are not shipped and do not run inside ChatGPT.

## Verification status

- **Automated, local:** package structure and extraction, limits and thresholds, rounding, the progress bar, the partial-history output (including the 50k/128k case), and instruction-text checks. These test the skill's text and a reference implementation, not ChatGPT.
- **Live ChatGPT:** installation and invocation in Work were checked manually by the maintainer. No automated test runs inside ChatGPT, and the exact replies a model produces for every scenario have not been independently graded.

## License

[MIT](LICENSE)
