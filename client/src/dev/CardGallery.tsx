import type { CardDef } from '@riftbound/engine';
import { Card, CardBack, CardPile, type CardInstanceView } from '../components/Card';
import { CardDetail } from '../components/CardDetail';
import { CardImagesProvider, ImageToggle } from '../components/CardImages';

const base: Pick<CardDef, 'subtypes' | 'keywords' | 'stats' | 'supportLevel' | 'domains'> = {
  subtypes: [],
  keywords: [],
  stats: {},
  supportLevel: 'full',
  domains: [],
};

const SAMPLES: { def: CardDef; instance?: CardInstanceView }[] = [
  {
    def: {
      ...base,
      cardId: 'g-unit-fury',
      name: 'Ember Raider',
      subtitle: 'Skirmisher',
      type: 'UNIT',
      subtypes: ['Human'],
      cost: { energy: 3, power: 1, domain: [{ element: 'Fury', amount: 1 }] },
      domains: ['Fury'],
      stats: { might: 3, health: 3 },
      keywords: [{ name: 'Assault', value: 1 }],
      text: '[Assault 1] (+1 Might while attacking.) When played, deal [3] damage.',
    },
    instance: { ready: true, damage: 0, mightBonus: 0 },
  },
  {
    def: {
      ...base,
      cardId: 'g-unit-calm',
      name: 'Mossback Guardian',
      type: 'UNIT',
      cost: { energy: 4, power: 2, domain: [{ element: 'Calm', amount: 1 }] },
      domains: ['Calm'],
      stats: { might: 2, health: 5 },
      keywords: [{ name: 'Tank' }, { name: 'Shield', value: 2 }],
      text: '[Tank] (Must be assigned damage first.) [Shield 2]',
    },
    instance: { ready: true, damage: 2, mightBonus: 1 },
  },
  {
    def: {
      ...base,
      cardId: 'g-spell-mind',
      name: 'Mind Spike',
      type: 'SPELL',
      subtypes: ['Arcane'],
      cost: { energy: 2, power: 2, domain: [{ element: 'Mind', amount: 2 }] },
      domains: ['Mind'],
      keywords: [{ name: 'Reaction' }],
      text: '[Reaction] Draw a card. [E]: ready a unit.',
    },
  },
  {
    def: {
      ...base,
      cardId: 'g-gear-body',
      name: 'Iron Gauntlet',
      type: 'GEAR',
      subtypes: ['Equipment'],
      cost: { energy: 1, power: 1, domain: [{ element: 'Body', amount: 1 }] },
      domains: ['Body'],
      keywords: [{ name: 'Equip' }],
      text: 'Attached unit gets [M] +2.',
    },
  },
  {
    def: {
      ...base,
      cardId: 'g-legend-chaos',
      name: 'Void Seer',
      subtitle: 'Who Watches',
      type: 'LEGEND',
      subtypes: ['Champion'],
      cost: { energy: 0 },
      domains: ['Chaos', 'Mind'],
      text: '[E]: add [C]. (Gain one domain power.)',
    },
  },
  {
    def: {
      ...base,
      cardId: 'g-rune-order',
      name: 'Order Rune',
      type: 'RUNE',
      cost: { energy: 0 },
      domains: ['Order'],
      text: '[E]: add [C].',
    },
    instance: { ready: false, damage: 0, mightBonus: 0 },
  },
  {
    def: {
      ...base,
      cardId: 'g-bf',
      name: 'Windswept Hills',
      type: 'BATTLEFIELD',
      cost: { energy: 0 },
      text: 'When you conquer here, draw a card.',
    },
  },
  {
    def: {
      ...base,
      cardId: 'g-partial',
      name: 'Hexcaster Adept',
      type: 'UNIT',
      cost: { energy: 5, power: 2, domain: [{ element: 'Chaos', amount: 1 }] },
      domains: ['Chaos'],
      stats: { might: 4, health: 4 },
      keywords: [{ name: 'Deathknell' }],
      supportLevel: 'partial',
      text: '[Deathknell] (When I die, do this.) Summon a token for [2].',
    },
    instance: { ready: true, damage: 0, mightBonus: 0 },
  },
  {
    def: {
      ...base,
      cardId: 'g-exhausted',
      name: 'Tired Sentinel',
      type: 'UNIT',
      cost: { energy: 2, power: 1 },
      stats: { might: 2, health: 2 },
      text: 'Colorless unit, exhausted.',
    },
    instance: { ready: false, damage: 1, mightBonus: 0 },
  },
  {
    def: {
      ...base,
      cardId: 'g-broken-img',
      name: 'Missing Portrait',
      type: 'SPELL',
      cost: { energy: 1, power: 1, domain: [{ element: 'Fury', amount: 1 }] },
      domains: ['Fury'],
      text: 'This card has a broken image URL; the text frame stays intact.',
      imageUrl: 'https://invalid.example/does-not-exist.png',
    },
  },
  {
    def: {
      ...base,
      cardId: 'g-multi',
      name: 'Twin Flame',
      type: 'SPELL',
      cost: {
        energy: 3,
        power: 2,
        domain: [
          { element: 'Fury', amount: 1 },
          { element: 'Order', amount: 1 },
        ],
      },
      domains: ['Fury', 'Order'],
      text: 'Multi-domain gradient frame.',
    },
  },
];

/** Dev-only gallery. Mount e.g. `if (location.search.includes('gallery')) return <CardGallery />`. */
export function CardGallery() {
  return (
    <CardImagesProvider>
      <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <div className="mb-4 flex items-center gap-4">
          <h1 className="text-xl font-bold">Card gallery</h1>
          <ImageToggle />
        </div>
        <div className="flex flex-wrap items-start gap-4">
          {SAMPLES.map(({ def, instance }) => (
            <Card key={def.cardId} def={def} instance={instance} size="hand" />
          ))}
          <CardBack owner={1 as never} />
          <CardPile label="Deck" count={30} size="hand" />
        </div>
        <h2 className="mt-8 mb-2 text-lg font-semibold">Board / chain sizes</h2>
        <div className="flex flex-wrap items-center gap-6 p-6">
          {SAMPLES.slice(0, 3).map(({ def, instance }) => (
            <Card key={def.cardId} def={def} instance={instance} size="board" />
          ))}
          <Card
            def={SAMPLES[7]!.def}
            instance={{ ready: false, damage: 0, mightBonus: 0 }}
            size="board"
          />
          <Card def={SAMPLES[2]!.def} size="chain" />
        </div>
        <h2 className="mt-8 mb-2 text-lg font-semibold">Detail</h2>
        <CardDetail def={SAMPLES[7]!.def} instance={SAMPLES[7]!.instance} />
      </div>
    </CardImagesProvider>
  );
}
