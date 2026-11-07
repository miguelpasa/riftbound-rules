# R70: filtered "here" statics

Status: done (engine, parser). Fully supported cards 380 -> 383 of 1103 (`convertRow` count): Kinkou Temple, Packed Amphitheater, Black Flame Altar. Engine 775 tests (+2); all checks green.

## What changed

`StaticAbility.onlyKeyword` / `onlySubtype`; `applies()` filters on them; the static parser reads "Units here with [Keyword]" and "Champion units here".
