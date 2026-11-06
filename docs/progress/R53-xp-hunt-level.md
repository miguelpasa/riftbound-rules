# R53: XP, Hunt and Level

Status: done (engine, parser, converter, client). Fully supported cards 299 -> 316 of 1103 (`convertRow` count, excluding the 6 token definitions). Engine 732 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green; golden hashes unchanged (`xp` is optional on PlayerState); Playwright smoke + solo pass on a temporary port.

## Measurement

`m53.ts` (scratchpad): stripping every Hunt / Level / XP line made 39 partial cards full, the largest family left (trash plays 31 and banish 33 overlap and need a choose-from-trash step).

## What changed

- `PlayerState.xp?`, effect `GAIN_XP` (event `XP_GAINED`, `perFriendlyUnit`), condition `XP` (Level N).
- Parser: "Gain N XP [for each friendly unit]", Hunt N as CONQUER + HOLD triggers, "[Level N][>] I have +N [M] / [Keyword] ..." as XP-conditional statics (grants now allow Might and keywords together), "When I move to a battlefield".
- Converter: `Hunt` is a parsed keyword. Client: XP shown next to the name on the scoreboard once non-zero; event text.
- Cards now full include Herald of Spring, Demacian Diplomat, Gemhand Hunter, Targonian Visionary, Voracious Gromp, Master Yi (Hunt version), Nilah, Mister Root, Scrutinizing Sergeant, Gustwalker, Mosstomper.

## Not done

Spending XP (Kha'Zix, Crowd Favorite, Megatusk, Legends), "if you've gained XP this turn", combat-win and death XP triggers, Buff, Level on spells / costs / "enter ready".
