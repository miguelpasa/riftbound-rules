/** Card ids of the default (fixture) decks, so lessons do not hard-code which deck a side has. */
export interface Kit {
  grunt: string;
  tank: string;
  archer: string;
  raider: string;
  shielder: string;
  ganker: string;
  wisp: string;
  titan: string;
  /** An Action-speed spell. */
  action: string;
  /** A Reaction-speed spell. */
  reaction: string;
  /** A spell with neither Action nor Reaction (Main Phase only, never during a chain). */
  plainSpell: string;
  equipment: string;
  rune: string;
}

/** The learner (p0, deck A: Fury/Calm). */
export const KIT_YOU: Kit = {
  grunt: 'fx-grunt', // Cinder Grunt, Fury, cost 2, might 2
  tank: 'fx-ash-tank', // Ash Bulwark, cost 3, might 3, Tank
  archer: 'fx-archer', // Flame Archer, cost 2, might 2, Backline
  raider: 'fx-raider', // Spark Raider, cost 2, might 2, Assault 1
  shielder: 'fx-shielder', // Dune Shielder, Calm, cost 2, might 2, Shield 1
  ganker: 'fx-ganker', // Dune Stalker, Calm, cost 3, might 3, Ganking
  wisp: 'fx-wisp', // Hollow Wisp, cost 1, might 0
  titan: 'fx-titan', // Dune Titan, cost 5 + 1 Calm power, might 7
  action: 'fx-flare', // Flare Bolt, Fury, cost 1, Action
  reaction: 'fx-ward', // Quick Ward, Calm, cost 1, Reaction
  plainSpell: 'fx-plain-spell', // Plain Chant, cost 2
  equipment: 'fx-blade', // Practice Blade, cost 1, Equip
  rune: 'fx-rune-fury',
};

/** The scripted opponent (p1, deck B: Mind/Order). */
export const KIT_OPP: Kit = {
  grunt: 'fx-tide-grunt',
  tank: 'fx-order-tank',
  archer: 'fx-tide-archer',
  raider: 'fx-tide-grunt', // deck B has no Assault unit
  shielder: 'fx-order-shielder',
  ganker: 'fx-tide-ganker',
  wisp: 'fx-wisp',
  titan: 'fx-order-titan',
  action: 'fx-tide-surge',
  reaction: 'fx-tide-guard',
  plainSpell: 'fx-plain-spell',
  equipment: 'fx-blade',
  rune: 'fx-rune-mind',
};
