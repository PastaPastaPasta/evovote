import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comment } from '../../discussion/reads';
import { base58Encode } from '../../model/bytes';
import { text } from '../../model/indexValue';
import type { SdkHandle } from '../../sdk/connection';
import { CommentItem } from './CommentItem';
import { Discussion } from './Discussion';

const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const AUTHOR = id32(7);
const BACKED = id32(8);

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: id32(1),
  ownerId: AUTHOR,
  pollKey: 'k',
  body: 'hello',
  createdAtMs: 1_700_000_000_000,
  ...over,
});

const render = (c: Comment, names = new Map<string, string>(), contenders: string[] = [], reply?: Comment) =>
  renderToStaticMarkup(
    <ol>
      <CommentItem comment={c} names={names} contenderIds={new Set(contenders)} replyTarget={reply} />
    </ol>,
  );

describe('comment rendering', () => {
  it('should escape a body that is HTML', () => {
    const html = render(comment({ body: '<img src=x onerror=alert(1)><script>alert(2)</script> & "quotes"' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt; &amp; &quot;quotes&quot;');
  });

  it('should escape names and drop bidi overrides from the body', () => {
    const html = render(
      comment({ body: 'safe‮gnirts' }),
      new Map([[AUTHOR, '<b onclick=x>mallory</b>']]),
    );
    expect(html).not.toContain('<b ');
    expect(html).toContain('&lt;b onclick=x&gt;mallory&lt;/b&gt;');
    expect(html).not.toContain('‮');
  });

  it('should show the DPNS name, or a short id when there is none', () => {
    expect(render(comment(), new Map([[AUTHOR, 'alice.dash']]))).toContain('<strong>alice.dash</strong>');
    const bare = render(comment());
    expect(bare).not.toContain('<strong>');
    expect(bare).toContain(`title="${AUTHOR}"`);
  });

  it('should badge the author only when they are a contender of this contest', () => {
    expect(render(comment(), new Map(), [AUTHOR])).toContain('contender');
    expect(render(comment(), new Map(), [BACKED])).not.toContain('contender');
  });

  it('should show who the comment supports', () => {
    const html = render(comment({ supports: BACKED }), new Map([[BACKED, 'bob.dash']]), [BACKED]);
    expect(html).toContain('supports');
    expect(html).toContain('bob.dash');
    expect(render(comment())).not.toContain('supports');
  });

  it('should not name a supported identity that is not a contender of this contest', () => {
    const html = render(comment({ supports: BACKED }), new Map([[BACKED, 'bob.dash']]), [AUTHOR]);
    expect(html).toContain('supports an identity that is not in this contest');
    expect(html).not.toContain('bob.dash');
  });

  it('should show a reply as such, with the parent when it is on screen', () => {
    const parent = comment({ id: id32(2), ownerId: BACKED });
    const html = render(comment({ replyTo: parent.id }), new Map([[BACKED, 'bob.dash']]), [], parent);
    expect(html).toContain('In reply to');
    expect(html).toContain('bob.dash');
    expect(render(comment({ replyTo: id32(2) }))).toContain('In reply to comment');
  });
});

describe('Discussion without a contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('should say it is not activated, not an error', () => {
    vi.stubEnv('VITE_DISCUSSION_TESTNET_CONTRACT_ID', '');
    const html = renderToStaticMarkup(
      <Discussion
        handle={{} as SdkHandle}
        network="testnet"
        pollKey={{ contractId: id32(3), documentTypeName: 'domain', indexName: 'i', indexValues: [text('a')] }}
        contenders={[]}
      />,
    );
    expect(html).toContain('Discussion is not activated on testnet.');
    expect(html).not.toContain('error');
  });
});
