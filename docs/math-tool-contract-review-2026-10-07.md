# Math and tool contract review (2026-10-07)

This revision separates independently verifiable content from delivery requirements. Incorrect numbers, missing business facts, unauthorized actions and destructive side effects still fail their own checks. It does not change dimension or source-question weights.

## Mathematics

The opt-in policy is `math-content-protocol-20261007-v1`. Exact-answer contracts use `exact_answer_v6`; progressive math parts use grader version `1.1.0`. Previous contract versions remain compatible and retain their original grading unless an explicit revision is applied.

| Task | Reviewed contract |
| --- | --- |
| RM-CN-007 | Five independent fields receive equal accuracy weight. Content contributes 90%, final-answer structure 10%. A reply with four correct fields and C=108.49 receives 82, not full credit: C must be 108.48. |
| RM-CN-014 | Only declared aliases for meeting labels are equivalent. The conflicting pairs and longest gap remain exact. Different pairs or a different number are incorrect. |
| MX3-18-P3 | Correct values `12` and `525` in one complete JSON object earn content credit; canonical per-item records remain required for the protocol points. This rule applies consistently to all reviewed math parts. Broken JSON, duplicate fields and approximate large integer conversion do not earn invented credit. |
| MX3-20-P4 | The representative CRT root is in `[0,n)`; `total` is the **unreduced** sum of representatives and may exceed that interval. The future prompt now states this explicitly. |

The checked-in bank revises 102 mathematical definitions: 34 exact-answer questions and 68 machine-graded progressive parts. Proof-only questions are unchanged. Canonical reference answers still earn full credit, and preceding reasoning cannot substitute for an incorrect final answer.

## Tools and CLI

The opt-in policy is `tool-contract-content-delivery-20261007-v1`. Twelve execution definitions from seven source questions are revised.

| Source | Reviewed contract |
| --- | --- |
| TC-CN-005 | A reminder label may use an equivalent reminder prefix while retaining the 9 o'clock team-meeting meaning. Date, reminder time, single delivery and negation guards stay exact. |
| TC-CN-006 / TC-CN-015 | The actual email/report artifact proves delivery. A chat confirmation does not have to duplicate its body or spreadsheet details. Tool arguments, artifact contents and side-effect checks remain enforced. |
| TC-CN-022 | Tar members may retain `data/logs/` or be relative to that directory. Validation requires exact saved bytes and rejects duplicate/colliding members, traversal, links, unexpected files and deletion without a valid archive. The initial absence of `archive.tar.gz` is explicit. |
| TC-CN-031 / TC-CN-038 | `workflow-checkpoints-v2` awards business/judgment progress directly (80%) and final submission separately (20%). A complete explicit refusal lacking `SAY` can earn 80; a blank, interrupted or contradictory reply cannot. Safety violations still score zero. Other tasks retain v1, including its 40-point failed-outcome cap. |
| TC-CN-050 | `delta_replicas` explicitly means the increase, so moving from 3 replicas to 4 takes 1. Same-host prior observation, branch condition and single mutation remain required. |

Tool/CLI candidate generators use the same reviewed contracts. A semantic Judge review may record a supported positive subcheck even when another fact is missing; it does not turn the missing fact into a pass. Real environment/Judge errors remain distinct from protocol failures and benchmark defects.

## Applying revisions to completed runs

The release metadata records original and revised scenario hashes. Frozen prompts/manifests, original answers, reasoning and token evidence must remain unchanged. A historical rescore must use an explicit revision ledger with old/new scores and reasons, backed up and applied transactionally. Compare task definitions before applying the same policy across models; matching IDs alone do not establish comparability.

The old contradictory CRT prompt and old tool contracts that rejected otherwise valid actions require a uniform defect disposition across comparable historical answers. Exclude an affected defective instance from the scored denominator, record it separately from runtime errors, and retain its original evidence. Regrading an empty answer cannot reconstruct the response a corrected question would have elicited. Do not grant full points or append an unrequested rerun.

This source update does not automatically rewrite historical scores. Synchronize future definitions with `pnpm bank:sync`; historical frozen definitions remain intact. Deployment-specific databases, model outputs and revision ledgers are not part of this change.

## Progress recovery

After a server reload, the REST progress fallback counts all frozen-run results and selects the latest result for each scenario. Only the recent display is limited to 50 rows. Previously a completed 920-instance run could appear to have only 50 results. The fallback query still omits answer and reasoning payloads.

## Verification

```sh
pnpm --filter server prisma:generate
pnpm build
pnpm test
pnpm test:deployment
```

Regression tests cover exact field credit, meeting aliases, combined versus canonical records, exact large integers, all mathematical reference answers, content versus final submission, partial semantic reviews, legacy checkpoint behavior, safety failures, generated tool contracts, hostile tar members and the complete 920-instance restored progress count.
