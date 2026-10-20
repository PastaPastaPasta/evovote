import { ElectionSteps } from '../charters/ElectionSteps';

export function AboutPage() {
  return (
    <div className="about-page">
      <header className="page-header">
        <h1 className="page-title">About EvoVote</h1>
        <p className="page-lead">
          EvoVote shows every contest on Dash Platform where masternodes decide who gets something: a username, a
          moderation seat, or any other contested value. Masternode owners can vote here, and anyone can follow
          along and discuss.
        </p>
      </header>

      <section>
        <h2>What a contest is</h2>
        <p>
          A Dash Platform app can mark some values as contested: when two identities want the same one, or a
          value is premium, masternodes vote on who gets it. Usernames are the familiar case. Look-alike
          characters (<code>0</code> and <code>o</code>, <code>1</code>, <code>l</code> and <code>i</code>) count
          as the same name, so two people asking for look-alike names end up in a vote.
        </p>
        <p>
          Masternodes can vote for a contender or abstain. Where the app allows it they can also vote{' '}
          <strong>lock</strong>, which gives the value to nobody. A regular masternode&apos;s vote counts 1 and an
          evonode&apos;s counts 4. Each masternode can change its vote up to four times; its latest vote is the one
          that counts.
        </p>
        <p>
          Everything you see is read live from Platform, with cryptographic proofs, straight from your browser.
          This version runs on <strong>testnet</strong>; mainnet follows once mainnet runs protocol 14.
        </p>
      </section>

      <section>
        <h2>Two kinds of sign-in</h2>
        <p>EvoVote asks for two different things, for two different jobs:</p>
        <dl className="kv-table about-kv">
          <div>
            <dt>Your Dash identity</dt>
            <dd>
              For writing: commenting on a contest, and proposing, joining or applying for a moderation team. Each
              write is a small fee paid from your identity&apos;s balance (applying for a seat also takes a 0.5 DASH
              contest fund). Use <strong>Sign in</strong> in the header: approve EvoVote in Dash Wallet, or paste a
              private key.
            </dd>
          </div>
          <div>
            <dt>A masternode voting key</dt>
            <dd>
              For voting only. Votes cost nothing and need no identity. Use <strong>Vote with masternode</strong>{' '}
              in the header and add your masternode with the private key of its registered voting address.
            </dd>
          </div>
        </dl>
        <p>
          A pasted key, and a masternode voting key, stay in this tab&apos;s memory: never saved or sent anywhere,
          and gone when you close the tab. Signing in with Dash Wallet adds a key that can only post comments; this
          browser keeps it, encrypted, so you stay signed in until you sign out or the key expires or is revoked. Everything is signed in your
          browser and sent straight to Platform. The voting key is{' '}
          <em>only</em> the one for the <code>votingAddress</code> shown by <code>protx info</code>; never paste a
          masternode&apos;s owner, operator or collateral key anywhere.
        </p>
      </section>

      <section>
        <h2>Discussion</h2>
        <p>
          Every contest has a public discussion under its results. Anyone can read it. To post, sign in with your
          Dash identity; a comment costs a fee of roughly 0.0004 to 0.0013 DASH depending on its length. You can say
          which contender you support, and reply to other comments.
        </p>
        <p>
          Comments are stored on Platform and are <strong>permanent</strong>: once posted, nobody can edit or
          delete them, including you. Masternodes vote with keys that cannot post, so a comment is never a vote.
        </p>
      </section>

      <section>
        <h2>Moderator elections</h2>
        <p>
          Some apps on Dash Platform, like Yappr, let masternodes elect who moderates them. Each such contract has
          one moderation seat, held by a team.
        </p>
        <ul>
          <li>
            <strong>The charter.</strong> A team leader files a charter: what the team would moderate and how, the
            share of moderation fees it takes, and how its earnings are split.
          </li>
          <li>
            <strong>Reasons.</strong> The charter lists the reasons the team may act on, like spam or abuse. Every
            ban, suspension, warning or deletion must cite one, and a team with no reasons can take no action.
          </li>
          <li>
            <strong>Joining.</strong> Anyone can ask to join a team with a message only its leader can read. The
            leader picks up to 15 members from those who asked.
          </li>
          <li>
            <strong>Applying.</strong> The leader applies for the seat with the chosen members. Applying costs a{' '}
            <strong>0.5 DASH contest fund</strong> that pays for the masternode vote and is{' '}
            <strong>not refunded</strong>, win or lose.
          </li>
          <li>
            <strong>The vote.</strong> After the first application, other teams have a set time to apply too. If
            one does, masternodes vote; a tie goes to the team that applied first, and a team that applies alone
            wins when that time runs out.
          </li>
          <li>
            <strong>Permanence.</strong> On protocol 14 the winning team keeps the seat for good: nobody can
            challenge it yet. Reasons, charters, join requests and applications are permanent too; they cannot be
            edited or deleted once filed.
          </li>
        </ul>
        <p>What it costs a team, step by step:</p>
        <ElectionSteps />
        <p>
          <a href="#/m">See the moderator elections →</a>
        </p>
      </section>

      <section>
        <h2>Source</h2>
        <p>
          EvoVote is open source:{' '}
          <a href="https://github.com/PastaPastaPasta/evovote" target="_blank" rel="noreferrer">
            github.com/PastaPastaPasta/evovote
          </a>
          . It has no backend: all data comes from Dash Platform through the official{' '}
          <a href="https://www.npmjs.com/package/@dashevo/evo-sdk" target="_blank" rel="noreferrer">
            Evo SDK
          </a>{' '}
          running in your browser.
        </p>
      </section>
    </div>
  );
}
