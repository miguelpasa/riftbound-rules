// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CardDef } from '@riftbound/engine';
import { Card, CardBack, CardPile } from './Card';
import { CardImagesProvider, ImageToggle } from './CardImages';

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const def: CardDef = {
  cardId: 't1',
  name: 'Test Knight',
  type: 'UNIT',
  subtypes: ['Human'],
  cost: { energy: 3, power: 2, domain: [{ element: 'Fury', amount: 1 }] },
  domains: ['Fury'],
  stats: { might: 3, health: 4 },
  keywords: [{ name: 'Tank' }, { name: 'Assault', value: 1 }],
  text: 'Do a thing. (Reminder here.) [E]: gain [M]. Pay [C] or [A] or [2].',
  supportLevel: 'full',
};
const ready = { ready: true, damage: 0, mightBonus: 0 };

describe('Card', () => {
  it('renders name, cost, keywords and text', () => {
    render(<Card def={def} instance={ready} />);
    expect(screen.getByText('Test Knight')).toBeInTheDocument();
    expect(screen.getByTestId('cost-energy')).toHaveTextContent('3');
    expect(document.querySelector('[data-pip="Fury"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-pip="any"]')).toHaveLength(1);
    expect(screen.getByText('Tank')).toBeInTheDocument();
    expect(screen.getByText('Assault 1')).toBeInTheDocument();
    expect(screen.getByText(/Do a thing/)).toBeInTheDocument();
    expect(screen.getByText('Unit · Human')).toBeInTheDocument();
  });

  it('renders symbols and muted reminder text', () => {
    render(<Card def={def} />);
    for (const s of ['E', 'M', 'C', 'A', 'N']) {
      expect(document.querySelector(`[data-symbol="${s}"]`)).not.toBeNull();
    }
    expect(screen.getByLabelText('Exhaust')).toBeInTheDocument();
    expect(screen.getByLabelText('2 energy')).toBeInTheDocument();
    const reminder = document.querySelector('[data-reminder]');
    expect(reminder).toHaveTextContent('(Reminder here.)');
  });

  it('shows partial badge only for partial cards', () => {
    const { rerender } = render(<Card def={def} />);
    expect(screen.queryByTestId('partial-badge')).toBeNull();
    rerender(<Card def={{ ...def, supportLevel: 'partial' }} />);
    const badge = screen.getByTestId('partial-badge');
    expect(badge).toHaveTextContent('Effect not implemented');
    expect(badge).toHaveAttribute(
      'title',
      "This card's rules text is not executed in this version",
    );
  });

  it('shows exhausted state and damage with effective might', () => {
    render(<Card def={def} instance={{ ready: false, damage: 2, mightBonus: 2 }} />);
    expect(screen.getByTestId('exhausted-label')).toHaveTextContent('Exhausted');
    expect(screen.getByTestId('damage-badge')).toHaveTextContent('2 damage');
    expect(screen.getByTestId('might')).toHaveTextContent('5');
    expect(screen.getByTestId('health')).toHaveTextContent('4');
  });

  it('hides exhausted/damage for a ready undamaged card', () => {
    render(<Card def={def} instance={ready} />);
    expect(screen.queryByTestId('exhausted-label')).toBeNull();
    expect(screen.queryByTestId('damage-badge')).toBeNull();
  });

  it('removes a broken image but keeps the text frame', () => {
    render(<Card def={{ ...def, imageUrl: 'https://x.invalid/a.png' }} />);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveAttribute('loading', 'lazy');
    fireEvent.error(img!);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Test Knight')).toBeInTheDocument();
    expect(screen.getByText(/Do a thing/)).toBeInTheDocument();
  });

  it('removes a slow image after 6 seconds', () => {
    vi.useFakeTimers();
    try {
      render(<Card def={{ ...def, imageUrl: 'https://x.invalid/slow.png' }} />);
      expect(document.querySelector('img')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(6100);
      });
      expect(document.querySelector('img')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders no img when showImages is false', () => {
    render(<Card def={{ ...def, imageUrl: 'https://x.invalid/a.png' }} showImages={false} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Test Knight')).toBeInTheDocument();
  });

  it('ImageToggle disables images globally and persists', () => {
    render(
      <CardImagesProvider>
        <ImageToggle />
        <Card def={{ ...def, imageUrl: 'https://x.invalid/a.png' }} />
      </CardImagesProvider>,
    );
    expect(document.querySelector('img')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Card images'));
    expect(document.querySelector('img')).toBeNull();
    expect(localStorage.getItem('riftbound.showImages')).toBe('false');
  });

  it('handles click and keyboard activation', () => {
    const onClick = vi.fn();
    render(<Card def={def} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: /Test Knight/ });
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(<Card def={def} onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /Test Knight/ }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('CardBack / CardPile', () => {
  it('renders a back with no card name', () => {
    render(<CardBack owner={1 as never} />);
    expect(screen.getByRole('img', { name: /Face-down card/ })).toBeInTheDocument();
    expect(screen.queryByText('Test Knight')).toBeNull();
  });

  it('renders pile label and count', () => {
    render(<CardPile label="Deck" count={30} />);
    expect(screen.getByText('Deck')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });
});
