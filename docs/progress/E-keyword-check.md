# E: Keyword rules check

|            |       |
| ---------- | ----- |
| Status     | Done  |
| Complexity | Low   |
| Model      | Haiku |

## What was delivered

Read the official Core Rules PDF (keyword glossary 800-832, which the web page fetch had cut off) and compared each keyword with the engine. Output: `docs/KEYWORD_RULES_CHECK.md` (verdict per keyword, mismatches with the exact fix, implementation briefs and card counts for the deferred keywords, recommended order).

## Result

MATCH: Accelerate, Action, Assault, Ganking, Reaction, Shield, Backline, Tank (except the Tank+Backline tie). MISMATCH: Equip cost is free (no value in card data), Quick-Draw lacks Reaction speed, Hidden gear is placed in the base, Temporary and Deflect ignored on Gear, Hide timing wording. Tracked as R36 in `docs/REMAINING.md`.

## Notes

Some rule numbers were inferred from PDF text extraction (Disarm, Empower, Stun marked UNCLEAR by the agent).
