import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContestedIndex } from '../../discovery/contracts';
import { base58Encode } from '../../model/bytes';
import { FieldTable } from './FieldTable';
import { IndexRules } from './IndexRules';
import { technicalText } from '../charters/PaidWrite';
import { ContestedName, homographMask } from './ContestedName';
import { CopyButton } from './CopyButton';
import { choiceHeading, currentVoteText } from './VoteModal';

const ID = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

describe('FieldTable', () => {
  it('should show identifiers short with a copy button, bytes truncated, long text clipped', () => {
    const html = renderToStaticMarkup(
      <FieldTable
        rows={[
          { name: '$ownerId', value: { kind: 'identifier', id: ID } },
          { name: 'blob', value: { kind: 'bytes', hex: 'ab'.repeat(40) } },
          { name: 'bio', value: { kind: 'text', text: 'y'.repeat(300) } },
          { name: 'meta', value: { kind: 'json', text: '{\n  "a": 1\n}' } },
          { name: 'empty', value: { kind: 'bytes', hex: '' } },
        ]}
      />,
    );
    expect(html).toContain(`title="${ID}"`);
    expect(html).toContain(`${ID.slice(0, 6)}…${ID.slice(-6)}`);
    expect(html).toContain('aria-label="Copy $ownerId"');
    expect(html).toContain(`0x${'ab'.repeat(20)}…`);
    expect(html).toContain('show all 300 characters');
    expect(html).not.toContain('y'.repeat(161));
    expect(html).toContain('(empty)');
  });

  it('should escape hostile document text', () => {
    const html = renderToStaticMarkup(
      <FieldTable rows={[{ name: '<b>', value: { kind: 'text', text: '<img src=x onerror=alert(1)>' } }]} />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
  });
});

describe('IndexRules', () => {
  it('should state the index, its resolution and its field filter', () => {
    const index: ContestedIndex = {
      documentTypeName: 'domain',
      indexName: 'parentNameAndLabel',
      properties: ['normalizedParentDomainName', 'normalizedLabel'],
      resolution: 1,
      fieldMatches: [{ field: 'normalizedLabel', regexPattern: '^[a-z]+$' }],
      description: 'Pick one',
    };
    const html = renderToStaticMarkup(<IndexRules index={index} />);
    expect(html).toContain('normalizedParentDomainName, normalizedLabel');
    expect(html).toContain('Pick one');
    expect(html).toContain('Lock is not allowed');
    expect(html).toContain('matches ^[a-z]+$');
  });
});

describe('CopyButton', () => {
  it('should be an icon with an accessible name, not the word "copy"', () => {
    const html = renderToStaticMarkup(<CopyButton text="abc" label="Copy contract id" />);
    expect(html).toContain('aria-label="Copy contract id"');
    expect(html).toContain('<svg');
    expect(html.replace(/<[^>]*>/g, '').trim()).toBe('');
  });
});

describe('vote modal wording', () => {
  const id = base58Encode(new Uint8Array(32).fill(3));
  it('should head the dialog with the contender\'s name, else a short id', () => {
    expect(choiceHeading({ type: 'identity', identityId: id }, 'alice')).toBe('Vote for alice');
    expect(choiceHeading({ type: 'identity', identityId: id })).toBe(`Vote for ${id.slice(0, 6)}…${id.slice(-6)}`);
    expect(choiceHeading({ type: 'lock' })).toBe('Vote lock: award it to no one');
  });

  it('should say each node\'s current vote in words', () => {
    const name = () => 'alice';
    expect(currentVoteText(undefined, name)).toBe('Has not voted yet');
    expect(currentVoteText({ type: 'identity', identityId: id }, name)).toBe('Votes for alice');
    expect(currentVoteText({ type: 'abstain' }, name)).toBe('Votes abstain');
  });
});

describe('technicalText', () => {
  it('should say the code once and leave out a detail that repeats the message', () => {
    expect(technicalText({ code: 40112, message: 'Already applied.', detail: 'raw' })).toBe('code 40112 · raw');
    expect(technicalText({ code: 49999, message: 'm', detail: 'raw (consensus error 49999)' })).toBe('raw (consensus error 49999)');
    expect(technicalText({ message: 'same', detail: 'same' })).toBe('');
  });
});

describe('ContestedName', () => {
  const marked = (label: string, registered?: string) =>
    [...label].filter((_, i) => homographMask(label, registered)[i]).join('');

  it('should mark the letters Platform rewrites, not digits already in form or hyphens', () => {
    expect(marked('Theroadnottaken')).toBe('oo');
    expect(marked('al1ce')).toBe('l');
    expect(marked('b0b')).toBe('');
    expect(marked('my-name')).toBe('');
  });

  it('should compare with the registered label, and mark nothing it cannot line up', () => {
    expect(marked('b0b', 'b0b')).toBe('');
    expect(marked('bob', 'b0b')).toBe('o');
    expect(marked('bob', 'b0bby')).toBe('');
  });

  it('should render the marked letters as highlights', () => {
    const html = renderToStaticMarkup(<ContestedName label="Bob-1" />);
    expect(html).toContain('<em class="homograph" title="Registers as 0">o</em>');
    expect(html).not.toMatch(/<em[^>]*>-/);
    expect(html).not.toMatch(/<em[^>]*>1/);
  });
});
