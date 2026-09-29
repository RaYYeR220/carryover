import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Captions } from '../../src/landing/Captions';

describe('Captions', () => {
  it('keeps trailing punctuation out of a low-confidence word’s dotted span', () => {
    render(
      <Captions
        items={[
          {
            id: 'c1',
            kind: 'them',
            who: 'Dana',
            text: [
              { text: 'Sure, let me pull up your' },
              { text: 'lisinopril', cls: 'lc' },
              { text: '. Can I get your date of birth, please?' },
            ],
          },
        ]}
      />,
    );
    // The full line reads naturally, with no stray space before the period.
    expect(screen.getByRole('paragraph').textContent).toMatch(/lisinopril\. Can I get/);
    // Only the word itself is in the low-confidence span, not the period.
    const lc = document.querySelector('[class*="lc"]');
    expect(lc?.textContent).toBe('lisinopril');
  });
});
