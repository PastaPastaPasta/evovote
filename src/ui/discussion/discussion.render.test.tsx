import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Comment } from '../../discussion/reads';
import { base58Encode } from '../../model/bytes';
import { text } from '../../model/indexValue';
import type { SdkHandle } from '../../sdk/connection';
import { CommentItem, type ContenderInfo } from './CommentItem';
import { Discussion } from './Discussion';
import { SignInPrompt } from './SignInPrompt';

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

const NOW = 1_700_000_000_000 + 3 * 3_600_000;
const info = (id: string, over: Partial<ContenderInfo> = {}): ContenderInfo => ({ id, color: '#008DE4', winner: false, ...over });

const render = (
  c: Comment,
  names = new Map<string, string>(),
  contenders: ContenderInfo[] = [],
  opts: { reply?: Comment; orphan?: boolean } = {},
) =>
  renderToStaticMarkup(
    <ol>
      <CommentItem
        comment={c}
        names={names}
        contenders={new Map(contenders.map((x) => [x.id, x]))}
        now={NOW}
        replyTarget={opts.reply}
        orphan={opts.orphan}
      />
    </ol>,
  );

describe('sign-in prompt', () => {
  it('should offer one sign-in button linking to the identity page', () => {
    const html = renderToStaticMarkup(<SignInPrompt />);
    expect(html).toContain('Join the discussion');
    expect(html).toContain('href="#/me"');
  });
});

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

  it('should badge a candidate author, and the winner only when they won', () => {
    expect(render(comment(), new Map(), [info(AUTHOR)])).toContain('Candidate');
    expect(render(comment(), new Map(), [info(AUTHOR)])).not.toContain('Winner');
    expect(render(comment(), new Map(), [info(AUTHOR, { winner: true })])).toContain('Winner');
    expect(render(comment(), new Map(), [info(BACKED)])).not.toContain('Candidate');
  });

  it('should show whom the author backs, with the contender colour', () => {
    const html = render(comment({ supports: BACKED }), new Map([[BACKED, 'bob.dash']]), [info(BACKED, { color: '#0FA88F' })]);
    expect(html).toContain('backs');
    expect(html).toContain('bob.dash');
    expect(html).toContain('#0FA88F');
    expect(render(comment())).not.toContain('backs');
  });

  it('should not say a candidate backs themselves', () => {
    expect(render(comment({ supports: AUTHOR }), new Map(), [info(AUTHOR)])).not.toContain('backs');
  });

  it('should not name a backed identity that is not a contender of this contest', () => {
    const html = render(comment({ supports: BACKED }), new Map([[BACKED, 'bob.dash']]), [info(AUTHOR)]);
    expect(html).toContain('backs someone who is not in this contest');
    expect(html).not.toContain('bob.dash');
  });

  it('should show a relative time with the full date in the tooltip', () => {
    const html = render(comment());
    expect(html).toContain('3 h ago');
    expect(html).toContain(`title="${new Date(1_700_000_000_000).toLocaleString()}"`);
  });

  it('should say whom a nested reply answers, and mark a reply whose parent is not loaded', () => {
    const parent = comment({ id: id32(2), ownerId: BACKED });
    const html = render(comment({ replyTo: parent.id }), new Map([[BACKED, 'bob.dash']]), [], { reply: parent });
    expect(html).toContain('to <span');
    expect(html).toContain('bob.dash');
    expect(render(comment({ replyTo: id32(2) }), new Map(), [], { orphan: true })).toContain('Reply to an earlier comment');
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
    expect(html).toContain('Comments don&#x27;t count as votes.');
    expect(html).not.toContain('error');
  });
});
