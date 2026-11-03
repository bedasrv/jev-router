# Jev prompt v2: eval, 2026-11-03

`plugin/ops/jev-eval.mjs`, run inside the staging container (it holds the Jev key; nothing deployed), against
`~typesafe/jev-latest` on OpenRouter. 32 cases × 3 seeds, each sent with the **before** payload (master's
`lib/jev.mjs` and the live production policy: 6 options with gpt-6-luna and qwen3.8-flash, the "pick c1" tie-break,
fixed order) and the **after** payload (this branch and `ops/apply-prompt-v2.mjs` on that policy: 4 options,
neutral question, named state facts, shuffled order, new descriptions). The set is mixed: 18 chat-app requests in
Indonesian (our system prompt, a few tools) and 14 API-client requests (a coding agent with many tools, or a bare
call), 4 of them follow-up turns with a previous model. Each case lists the models a reader of the Artificial
Analysis readings accepts (`ok:` in the script): those labels are this builder's judgement. 192 calls per run,
$0.011 per run.

"Served" counts what the router would serve: Jev's pick when its confidence reaches the threshold, else the
default the code keeps (before: the configured head, deepseek; after: the conversation's previous model, else the
configured head).

## Run 1: first descriptions

| | pick accuracy | answers at confidence ≥ 0.9 | served at the live 0.6 |
|---|---|---|---|
| before | 74% | 1% | 80% |
| after | 74% | 34% | 80% |

After's misses: muse-spark was confidently picked for quick facts, proofs, puzzles and long documents (its "factual
accuracy" good_at outweighed "slow").

## Run 2: muse narrowed to specialist knowledge, deepseek names quick everyday questions and reasoning

BEFORE (master payload, live policy): pick accuracy 74%

| confidence | n | accuracy |
|---|---|---|
| 0.0-0.3 | 13 | 69% |
| 0.3-0.5 | 26 | 58% |
| 0.5-0.6 | 15 | 93% |
| 0.6-0.7 | 11 | 73% |
| 0.7-0.8 | 13 | 54% |
| 0.8-0.9 | 12 | 100% |
| 0.9-1.0 | 6 | 100% |

AFTER (v2 payload, v2 policy): pick accuracy 88%

| confidence | n | accuracy |
|---|---|---|
| 0.0-0.3 | 2 | 100% |
| 0.3-0.5 | 12 | 75% |
| 0.5-0.6 | 7 | 100% |
| 0.6-0.7 | 9 | 78% |
| 0.7-0.8 | 11 | 82% |
| 0.8-0.9 | 15 | 93% |
| 0.9-1.0 | 40 | 90% |

| threshold | before applied | before acc. applied | before served | after applied | after acc. applied | after served |
|---|---|---|---|---|---|---|
| 0.50 | 59% | 82% | 80% | 85% | 89% | 91% |
| 0.60 | 44% | 79% | 78% | 78% | 88% | 91% |
| 0.70 | 32% | 81% | 78% | 69% | 89% | 93% |
| 0.80 | 19% | 100% | 84% | 57% | 91% | 95% |
| 0.85 | 9% | 100% | 84% | 51% | 90% | 95% |
| 0.90 | 6% | 100% | 84% | 42% | 90% | 94% |
| 0.95 | 0% | - | 84% | 28% | 96% | 96% |

After's remaining misses (12 of 96): a pasted employment contract with an "find contradictions and risks" ask goes
to muse (legal knowledge; defensible, but slow on a long document); a tax follow-up whose previous model was muse
switches confidently to deepseek (the label asked to stay); a linter fix whose previous model was glm switches to
mimo (loses the cache); an unconfident muse pick on a long spec (served correctly by the default).

**Proposed apply threshold: 0.85.** From 0.8 the applied picks are at least 90% right (0.80: 91% on 55; 0.85: 90%
on 49), and served accuracy is 95% at both, against 84% for the old payload at any threshold and 78% at the live
0.6. 0.85 rather than 0.8 because revision 2 was made after looking at run 1 on this same set, so these numbers
are optimistic; the mid-range (0.6-0.8) is where Jev is overconfident, as AA's Decision Index shows. Re-measure on
the decision log after a shadow week before raising `jev.mode` back to `on`.
