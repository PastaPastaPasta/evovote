import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContestedIndex } from '../../discovery/contracts';
import { base58Encode } from '../../model/bytes';
import { FieldTable } from './FieldTable';
import { IndexRules } from './IndexRules';

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
