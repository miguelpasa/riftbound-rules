import { costCardText } from '@riftbound/engine';
import type { CardDef } from '@riftbound/engine';
import { Card, PARTIAL_TOOLTIP, RulesText, type CardInstanceView } from './Card';
import { keywordLabel, typeLine } from './cardStyles';

/** Large zoom panel with the full, unclamped card text. */
export function CardDetail({ def, instance }: { def: CardDef; instance?: CardInstanceView }) {
  return (
    <aside
      aria-label={`Card detail: ${def.name}`}
      className="flex w-80 flex-col gap-3 rounded-xl bg-slate-900 p-3"
    >
      <Card def={def} instance={instance} size="detail" />
      <div className="text-sm text-slate-200">
        <h3 className="font-bold">
          {def.name}
          {def.subtitle ? (
            <span className="font-normal text-slate-400"> - {def.subtitle}</span>
          ) : null}
        </h3>
        <p className="text-slate-400">{typeLine(def)}</p>
        {def.keywords.length > 0 ? (
          <p className="mt-1">{def.keywords.map(keywordLabel).join(', ')}</p>
        ) : null}
        <p className="mt-2 leading-relaxed">
          <RulesText text={def.text} />
        </p>
        {def.additionalCost ? (
          <p className="mt-2 text-amber-200" data-testid="additional-cost">
            {`Additional cost to play: ${costCardText(def.additionalCost.card)}.`}
          </p>
        ) : null}
        {def.supportLevel === 'partial' ? (
          <p className="mt-2 text-amber-300">{PARTIAL_TOOLTIP}.</p>
        ) : null}
      </div>
    </aside>
  );
}
