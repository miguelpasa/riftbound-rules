# R67: counted statics

Status: done (engine, parser). Fully supported cards 368 -> 374 of 1103 (`convertRow` count): Seraphine-style "for each" cards (Sett, Ornn, Draven, Petal Pixie, Repair Specialist, Ancient Warmonger and others). Engine 771 tests (+3); all checks green.

## What changed

`StaticAbility.per` / `perKeyword`, `countStatic` in `statics.ts`, parser `parseCountedStatic` ("I have +N [M] for each ...", "My Might is increased by your points", "I have [Assault] equal to the number of ...").

## Not done

See ASSUMPTIONS R67.
