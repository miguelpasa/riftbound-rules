import type { ReactNode } from 'react';

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Inline minimal markdown: **bold** and `code`. Never injects HTML. */
export function renderInline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-amber-200">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={i}
          className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[0.85em] text-sky-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/** Paragraphs separated by blank lines, each rendered with inline markdown. */
export function Md({ text, className = '' }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {paragraphs.map((p, i) => (
        <p key={i}>{renderInline(p.trim())}</p>
      ))}
    </div>
  );
}
