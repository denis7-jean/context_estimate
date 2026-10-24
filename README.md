# contextestimate

A [ChatGPT skill](https://help.openai.com/en/articles/20001066-skills-in-chatgpt) that estimates the conversation text the assistant can currently access, compares it with a **planning limit** on a progress bar, and tells you whether to run your own `/handoff` skill.

It does not read ChatGPT's hidden context meter, and it never runs `/handoff` for you. Three things are kept separate: (1) the accessible text it estimates, (2) the planning limit used for the bar and the handoff guidance, and (3) the actual model window, backend token usage, and internal compaction, which it cannot see.

## Examples

With the Work model stated (`/contextestimate model=gpt-6.1-sol`), the planning limit is OpenAI's documented Work default for that model:

```
Context Estimate
Estimated accessible text: ~130k tokens
Planning limit: 500k (documented GPT-6.1 Sol / Work default)
Model: GPT-6.1 Sol (supplied by you with model=; recognized; Work window documented)
[█████░░░░░░░░░░░░░░░] ~26% of planning limit

Planning risk: LOW
Recommendation:
Continue normally.

Note: Visible-text estimate against the documented window; backend usage is unknown.
```

With no model evidence and no budget, it falls back to a conservative baseline and says the model window is unknown. The bar and percentage are still drawn against that baseline, but the planning risk is `UNKNOWN` and the recommendation is neutral: an unknown window is not, by itself, a reason to hand off.

```
Context Estimate
Estimated accessible text: ~130k tokens
Planning limit: 128k (conservative baseline; model window unknown)
Model: not identified (no trusted runtime metadata and no model=)
[████████████████████] ~102% of planning limit

Planning risk: UNKNOWN (model window unknown)
Recommendation:
A model-relative handoff assessment is unavailable because the model window is unknown. For a planning comparison, invoke this skill again with `limit=N` in the same message, e.g. `@contextestimate limit=250000`.

Note: Visible-text estimate against a conservative baseline; the model window and backend usage are unknown.
```

A model you name that the registry recognizes, but for which OpenAI documents no ChatGPT Work window, is reported as exactly that (here `/contextestimate model= GPT-6 Sol`, with a space after `=`). The baseline still draws the bar, but the recommendation says what is unknown and offers only your own budget, which is a planning figure and not the model's real window:

```
Context Estimate
Estimated accessible text: ~50k tokens
Planning limit: 128k (conservative baseline; model window unknown)
Model: GPT-6 Sol (supplied by you with model=; recognized; no ChatGPT Work window documented)
[████████░░░░░░░░░░░░] ~39% of planning limit

Planning risk: UNKNOWN (model window not documented)
Recommendation:
GPT-6 Sol was recognized, but no ChatGPT Work context window is documented, so a model-relative handoff assessment is unavailable. For a planning comparison, invoke this skill again with your own budget in the same message, e.g. `@contextestimate limit=250000` (a planning figure, not the model's actual window).

Note: Visible-text estimate against a conservative baseline; the model window and backend usage are unknown.
```

When earlier history is summarized or truncated, or attachments/images can't be counted, it shows what it counted, labels it partial, and reports `UNKNOWN` under any limit:

```
Context Estimate
Estimated accessible text: ~130k tokens (partial)
Planning limit: 500k (documented GPT-6.1 Sol / Work default)
Model: GPT-6.1 Sol (supplied by you with model=; recognized; Work window documented)
[█████░░░░░░░░░░░░░░░] ~26% of planning limit (partial)

Planning risk: UNKNOWN (partial history)
Recommendation:
Consider /handoff before substantial work; earlier history is not counted.

Note: Counts visible text only, not ChatGPT's backend token usage or internal compaction; earlier history is summarized or truncated, so actual usage may be higher or lower.
```

- The percentage is the share of the **planning limit** and is never capped (`~117%` is shown beside a full bar). A full bar does not show that the model's real window is exceeded.
- The bar is a visual aid: 20 blocks, 5% each, `floor(u/5 + 0.5)` filled, at least 1 for any nonzero share, 20 only at 100% or more. Planning risk is always written in words.
- **Planning risk** is a threshold label on that share: LOW below 50%, MEDIUM 50% to below 70%, HIGH 70% to below 90%, CRITICAL 90% or more, on the unrounded value. It is planning guidance, not measured backend context risk. It is `UNKNOWN` when history is partial, attachments are unmeasured, the magnitude can't be justified, or the only denominator is the baseline for an unknown model window.
- If your ChatGPT view can't render `█` and `░`, add `bar=ascii` for a `#` / `.` bar.

## Planning limit and model evidence

The planning limit is the first of these that applies, and its source is always shown in parentheses:

| Order | Source | Label |
| --- | --- | --- |
| 1 | A valid `limit=N` in this invocation | `user override` |
| 2 | A valid `saved_limit` you set in the skill | `saved user budget` |
| 3 | A documented Work default for the model identified by **current** evidence | `documented GPT-6.1 Sol / Work default` |
| 4 | Otherwise 128000 | `conservative baseline; model window unknown` |

- **The only documented default is GPT-6.1 Sol: 500,000 tokens in ChatGPT Work and Codex**, from [OpenAI's Help Center](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) (wording checked on 2026-10-23). It is a product- and model-specific default: it isn't applied to other models, API specifications aren't substituted for Work limits, and it isn't a promise that all of it is available for conversation text. The skill never browses the web to look up limits.
- **Model evidence is re-checked on every invocation.** It accepts trusted runtime metadata that identifies both the model and the Work surface, or a `model=` value in that invocation's first line. `model=gpt-6.1-sol` is **your assertion** of the Work model you selected, not automatic detection. It does not accept the assistant naming its own model, a model name in quoted, pasted, summarized, or tool content, an earlier invocation's `model=`, the plan, or the task type. After a model switch with no new evidence, the skill uses your budget or the baseline; it never reuses an earlier derived limit.
- **A pinned budget stays put.** `limit=N` or `saved_limit` is a consistent comparison baseline across model switches, labeled as your budget. It is not the model's actual capacity, and an inferred model, model-derived limit, or the baseline is never saved into `saved_limit`.
- There is **no table of other models' windows**, and no accuracy guarantee across models: the estimate is applied by the model's judgment and checked only against one tokenizer on small synthetic texts.

```
@contextestimate model=gpt-6.1-sol
@contextestimate limit=200000
@contextestimate limit=200000 model=gpt-6.1-sol    (the budget wins; the label stays "user override")
@contextestimate bar=ascii
```

`limit=N` must be a positive integer with no separators or suffixes (`200k` is ignored with a note). Options are read from the first line of the message only and apply to that message only. To keep a budget, edit `saved_limit:` in the skill's `SKILL.md` and re-upload.

An unknown window never triggers a handoff recommendation by itself. A recommendation comes from a known planning limit and its thresholds, or from a separate explicit reason such as missing history or unmeasured attachments (which keep their `UNKNOWN` labels and "consider a handoff" advice under any limit).

### Work model registry and freshness checks

`SKILL.md` carries a compact registry of the ChatGPT Work models OpenAI documents, last checked **2026-10-23** against [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) (Help Center) and [Models](https://learn.chatgpt.com/docs/models) (ChatGPT Learn):

| Model ID / name | Work context window | Source |
| --- | --- | --- |
| `gpt-6.1-sol` (GPT-6.1 Sol) | **500,000** ("default context window of 500,000 tokens in ChatGPT Work and Codex") | Help Center |
| `gpt-6-sol` (GPT-6 Sol) | not documented | Learn |
| `gpt-6-luna` (GPT-6 Luna) | not documented | Learn |
| GPT-6 Astra (ID not documented) | not documented | Learn |
| GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna (IDs not documented) | not documented | Learn |

- A listing does not mean a model is available to every user: availability varies by plan, workspace settings, role, and rollout, and the registry is not the exact list any one account sees.
- A window is an exact number only where an official source explicitly gives a ChatGPT Work or Work-and-Codex value. Windows are never inferred from API documentation, output limits, usage allowances, or similarity to another model, so everything marked "not documented" keeps the baseline and `UNKNOWN (model window not documented)`.
- **Ordinary estimates do not browse.** Only if web search is available, the skill checks official OpenAI sources when you explicitly ask for current model or window information, when you give a model that isn't in the registry, when that model's row was last checked more than 90 days ago (if it doesn't reliably know today's date, it treats the row as fresh), or when your invocation includes `model=` for a recognized model with no documented Work window. In that last case it searches for that exact model's ChatGPT Work context window; invocations without `model=` never trigger it. A looked-up value is accepted only if the source explicitly scopes that number to ChatGPT Work or Work and Codex for that model. It is used for that invocation only and labeled `documented <Model> / Work default; live check`. The skill never claims it or its registry was updated, never saves it, and never implies the model is available to your workspace.
- If the source is inaccessible, ambiguous, stale, or API-only, or there is no search, the window stays unknown and the baseline applies. A registry window older than 90 days that can't be rechecked is treated as unknown (with a note) until you re-upload a refreshed skill or pass `limit=N`.
- Which model is current still comes only from `model=MODEL_ID` (your assertion) or trusted runtime metadata; a lookup or the registry never decides it.
- The live lookup has not been verified in ChatGPT Work, and no registry value has been tested there; the automated tests check policy and instruction text only.

### How the model was resolved

Every report has a `Model:` line saying where the model name came from and what is known about it. A name you typed is always "supplied by you with `model=`", never "detected"; "from trusted runtime metadata" appears only when the platform itself supplies the model and the Work surface.

| State | `Model:` line (status) | Planning risk | Recommendation |
| --- | --- | --- | --- |
| Recognized, Work window documented (GPT-6.1 Sol) | `recognized; Work window documented` | normal LOW to CRITICAL | normal planning guidance |
| Recognized, no documented Work window | `recognized; no ChatGPT Work window documented` | `UNKNOWN (model window not documented)` | says the model was recognized but no Work window is documented; offers only `limit=N` as your own budget |
| Not recognized | `not recognized, not in the Work model registry` | `UNKNOWN (model not recognized)` | asks for a clearer model name or `limit=N` |
| Ambiguous or incomplete (`Sol`, `Luna`) | `ambiguous or incomplete, could be ...` | `UNKNOWN (model ambiguous)` | asks for the full model name or `limit=N` |
| No model information | `not identified (no trusted runtime metadata and no model=)` | `UNKNOWN (model window unknown)` | says the window is unknown; offers `limit=N`; does not suggest that repeating a model name will reveal it |

`model=` is parsed as the rest of the first line (up to the next `limit=`, `bar=`, or `model=`), so `model= GPT-6 Sol`, `model=GPT-5.6 Terra`, and quoted or backtick-quoted names work, with spaces around `=` allowed. A name matches a registry row by ID, full name, name without `GPT-` (`6 Sol`), or the official short label `Astra`, optionally followed by a reasoning effort as the model picker shows it (`GPT-6.1 Sol Medium`). Case, spaces, hyphens, and underscores don't matter. Bare family words (`Sol`, `Luna`) are ambiguous. No ID or window is ever invented, and none of these states recommends `/handoff` on its own. Missing history or unmeasured attachments still do, as before.

### Getting a parameterized estimate

When a report says a model-relative assessment is unavailable, the next step is explicit: **invoke or select the skill again and put the parameter in that same message.** In ChatGPT Work, type `@` to select a skill (OpenAI documents `@` for selecting a skill, for example `@skill-creator` in Work), then add the option on the same line:

```
@contextestimate limit=250000
@contextestimate model=gpt-6-luna
@contextestimate model=gpt-6.1-sol
/contextestimate limit=250000
```

- Sending a separate follow-up message that contains only `model=...` or `limit=...` does not necessarily invoke the skill, and it never updates the previous report. A bare message like that is not an invocation.
- On the new invocation the parameter applies to that run only, and the estimate is recalculated from the visible conversation that is accessible now (it doesn't patch the earlier report's numbers). The next plain invocation falls back to the baseline again unless a saved budget applies.
- `model=NAME` is a user-provided assertion, not automatic model detection. It changes the limit only when OpenAI documents a Work window for that model; today that is just GPT-6.1 Sol, so `model=gpt-6-luna` is recognized and reported as such but leaves the baseline and `UNKNOWN (model window not documented)`. Repeating the same model name won't change that; only `limit=N` gives a comparison, and `limit=N` is your own planning budget, not the model's real window.
- `limit=N` is a user-provided planning budget. It works for any model and is labeled `user override`, not the model's capacity.
- `/contextestimate` is instruction text the skill recognizes. It has not been verified as a registered ChatGPT slash command, so the `@` form above is the one to use.

### Observed smoke tests (ChatGPT Work)

**Model resolution (latest live tests).** With GPT-6.1 Sol selected and no `model=`, the skill reported the registered 500k default, so the model was identified without `model=`. The skill's rules accept only trusted runtime metadata for that (not the assistant naming itself), and which of the two happened is not established. With GPT-6 Sol, GPT-6 Luna, GPT-6 Astra, and GPT-5.6 Terra it reported the 128k baseline and `UNKNOWN`, including for `/contextestimate model= GPT-6 Sol`, and asked to repeat `model=MODEL_ID`. Those results could not show whether a name had been parsed or recognized: `model= GPT-6 Sol` (a space after `=`) was in fact not parsed at all, and a recognized model with no documented window looked identical to an unrecognized one. Fixes: `model=` accepts whitespace around `=`, multiword names, quotes and backticks, and unambiguous aliases; every report says how the model was resolved; each state has its own risk reason and recommendation; and a recognized model with no documented window is only asked for `limit=N`. Regression scenarios cover the observed input and the other models; the accessible-text estimate is checked to be identical whichever model is named. These are automated checks of the instructions and a reference implementation. None has been run in live ChatGPT Work since the change.

In a new Work chat the user sent `hi` on GPT-6 Luna Medium, got "Hi! What would you like to work on?", sent `Hello World` on GPT-6.1 Sol Medium, got "Hello, world! 👋", and then ran `/contextestimate` on Sol (`<1k` tokens against the documented 500k) and again on Luna. The Luna run reported `~5k` tokens against the 128k baseline with `UNKNOWN` risk and a recommendation to consider a handoff because the model window is unknown. That showed two problems, both fixed here:

- **An unknown window was turned into a handoff warning.** It now produces a neutral recommendation (see the examples above) that depends on why the window is unknown.
- **The same tiny conversation was sized ~5x larger on one model.** The accessible text in that exchange is a few dozen tokens, so ~5k is not a plausible count of it. One unverified explanation is that non-countable material (the skill's own text (~3.9k tokens in the tested version), instructions, memory, tool definitions) was counted. The skill text now says outright that a few short messages are well under 1k, that a total in the thousands for such a chat means non-countable text is being counted, and that the total should not depend on the selected model. A synthetic regression fixture checks this sizing against the reference estimator and a tokenizer. It is a sizing sanity test, not proof that a language model returns an exact, repeatable count in a live invocation, and neither live number is treated as ground truth. No rates or thresholds were changed.

Different estimates from different models, or after a switch, can reflect estimation variability or differences in the accessible history. They are not measurements of backend context usage, and the skill never explains a difference as one.

**Second live case (same conversation, Luna first).** The visible exchange was still only the greeting messages. `/contextestimate` on Luna reported about `10k` tokens, and after switching to Sol it reported about `1k`. The visible text is a few dozen tokens (a few hundred at most with the earlier report in view), so neither number is credible, and the second run saw essentially the same text as the first. The remaining defect was in how the skill told the model what to count, not in the planning-limit rules. A short "sanity check" paragraph placed after the rates did not stop the oversize, most likely because it was advice to apply after a total already existed and the countable list ("tool results and file text present in your context") could be read as including the skill's own text when it is loaded as a file or tool result. The counting section is now an ordered procedure:

1. collect the visible user and assistant messages (earlier `/contextestimate` reports are ordinary messages, and a number printed in a report is never the conversation's size);
2. add accessible tool, file, and summary text once each;
3. exclude everything that isn't transcript even if it arrived as a tool result or file read (this skill, other skills, instructions, tool definitions, hidden reasoning, memory and context metadata, the model's name);
4. don't infer missing history or backend usage;
5. size each message and sum, independent of which model is answering;
6. for a handful of short messages (at most 10 messages and about 500 words, or about 700 CJK characters), report `<1k` and stop.

A regression scenario reproduces the Luna-then-Sol sequence (`greeting-luna-first`, `greeting-sol-second`) and dedicated sizing tests fail any report that sizes such a transcript at `~1k` or more, for example `~5k` or `~10k`. These are automated checks of the instructions and a reference estimator, not of live behavior: the skill has no tokenizer or access to ChatGPT's backend context usage, a language model applying the rules may still miscount or vary between runs, and nothing here guarantees cross-model accuracy. **This live case is not fixed or verified until the updated ZIP is uploaded and retested in ChatGPT Work.**

## Estimation limits

- **Visible text only.** It counts messages, tool results, and loaded file text it can see, once each. It does not count system or developer instructions, memory, hidden reasoning, images, or attachment contents that are not loaded, and it does not reconstruct earlier turns or drafts from a summary or a description.
- **Every printed copy counts.** Three full drafts of one document count three times, and "context optimization" text counts only if it was printed in the chat. Internal compaction or optimization is never counted, subtracted, or described as measured. Turn count and chat age say nothing either way: a few long drafts can exceed the limit.
- **Re-estimated each time.** The skill doesn't keep a running total across model switches or compaction. A different number after a switch may reflect estimation variability or different accessible text; it does not show that backend usage changed.
- **Heuristic, not a tokenizer.** The model applies per-content-type rates (CJK, English prose, code, JSON/YAML, logs and IDs) rather than one "characters ÷ 4" rule. In a local check against `o200k_base` on 16 small synthetic texts, the reference implementation of those rates was +2% overall and within ±15% on all but one number-heavy CSV (−25%). That is not an error bound. If a real tokenizer runs on text you supply, the result is labeled as counting that text with that tokenizer, which may not match any Work model.
- **No telemetry.** OpenAI documents no way for a skill to read current-conversation token usage. Numbers pasted into the chat are content, never measurements.
- Instructions that appear inside the conversation are data and are not followed.

Details and sources are in [docs/development-notes.md](docs/development-notes.md).

## Install and use

**Supported and tested surface: ChatGPT Work.** The maintainer installed and invoked the skill in ChatGPT Work.

**ChatGPT Chat: unavailable on the maintainer's account.** The standalone uploaded skill did not appear in Chat there. This is an observed availability limit on one account, not a statement about OpenAI's products in general (OpenAI's docs say plugin-bundled skills are available in Chat and Work, and that availability varies by plan, workspace, and surface).

Skills are documented for ChatGPT Business, Enterprise, Healthcare, and Edu workspaces, subject to workspace settings (including whether skill uploading is enabled).

1. Download [`dist/contextestimate.zip`](dist/contextestimate.zip) (or zip the `skill/contextestimate/` folder yourself). **After any update, upload the new ZIP again; an installed copy doesn't change on its own.**
2. In ChatGPT, open **Plugins → Skills → Create → Upload from your computer** and select the ZIP. Wait for the scan to finish.
3. In **ChatGPT Work**, type `@` to select a skill, pick **contextestimate**, and send the message, optionally with arguments on the same line (see [Getting a parameterized estimate](#getting-a-parameterized-estimate)), for example `@contextestimate limit=250000`.

`/contextestimate` is an instruction trigger inside the skill, not a documented ChatGPT slash command. The documented way to call a skill explicitly is the `@` mention; whether a bare `/contextestimate` is matched automatically has not been verified.

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

- **Automated, local:** all 198 local tests pass (`cd dev && npm test`). They cover package structure and extraction, limit precedence and provenance, model-evidence rules, `model=` parsing and registry matching, the per-state model reporting, the lookup acceptance rules, the progress bar, planning-risk labels, partial-history output, and instruction-text checks. These test the skill's text and a reference implementation, not ChatGPT, and they don't show that any model follows the instructions.
- **Live ChatGPT:** the maintainer manually ran installation, invocation, and the greeting smoke tests above in Work. Those live runs found the defects fixed in this version (an unknown window turned into a handoff warning, a greeting exchange sized at ~5k and ~10k tokens, and `model=` input that was not parsed or distinguishable from an unrecognized name). The fixes have not been re-tested live, and the sizing defect in particular may recur. The updated skill (model parsing and reporting, the new recommendations) and the targeted model lookup have not been verified in live ChatGPT Work: neither has been uploaded or run there, and whether Work gives a skill search access is unknown. No automated test runs inside ChatGPT, and no independent model has been run against the skill text.

## License

[MIT](LICENSE)
