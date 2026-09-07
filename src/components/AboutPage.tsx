export function AboutPage() {
  return (
    <div className="about-page">
      <h1>About EvoVote</h1>

      <section>
        <h2>What a username contest is</h2>
        <p>
          Dash Platform usernames (DPNS names) normalize look-alike characters:
          <code>0</code> and <code>o</code>, <code>1</code>/<code>l</code>/
          <code>i</code>, and hyphens all collapse to the same normalized name.
          Short or premium names, and any name whose normalized form is
          requested by more than one identity, are not handed out automatically
          — masternodes vote on who gets the name. That vote is what you see
          here, read live from Platform with cryptographic proofs.
        </p>
        <p>
          A contest runs for about two weeks. Masternodes can vote for a
          contender, <strong>abstain</strong>, or vote <strong>lock</strong>,
          which awards the name to no one. Regular masternodes vote with weight
          1, evonodes with weight 4, and each masternode may cast up to 5 votes
          per contest — the most recent vote is the one that counts.
        </p>
      </section>

      <section>
        <h2>How voting works in this app</h2>
        <p>
          EvoVote is a static page with no backend. All data comes from Dash
          Platform through the official Evo SDK running in your browser, and
          votes are signed the same way:
        </p>
        <ol>
          <li>
            You add a masternode's <code>ProTxHash</code> and the private key
            (WIF) of its registered <strong>voting address</strong>.
          </li>
          <li>
            The key stays in this tab's memory. It is never persisted, never
            sent to a server, and is gone when the tab closes.
          </li>
          <li>
            The vote transition is signed locally and broadcast directly to
            Platform nodes. Platform derives your voter identity from the
            ProTxHash plus the voting key hash — no Platform identity or
            credits are needed.
          </li>
        </ol>
        <p>
          The voting key is <em>only</em> the <code>votingAddress</code> key
          from <code>protx info</code>. Owner, operator (BLS), and collateral
          keys are different keys with more power — never paste those anywhere.
        </p>
      </section>

      <section>
        <h2>Discussing a contest</h2>
        <p>
          Comments and replies use a normal Dash Platform identity with credits.
          Connect a compatible Dash wallet to approve each comment, or sign in
          with an authentication key. EvoVote discovers your identity from the
          key’s public hash; you do not need to enter an identity ID.
        </p>
        <p>
          Comments are public and permanent, and their storage fees are paid
          from your Platform credits. Discussion does not affect official
          tallies: those votes still require a masternode voting key.
        </p>
      </section>

      <section>
        <h2>Source</h2>
        <p>
          EvoVote is open source:{' '}
          <a
            href="https://github.com/PastaPastaPasta/evovote"
            target="_blank"
            rel="noreferrer"
          >
            github.com/PastaPastaPasta/evovote
          </a>
          . Data access uses{' '}
          <a
            href="https://www.npmjs.com/package/@dashevo/evo-sdk"
            target="_blank"
            rel="noreferrer"
          >
            @dashevo/evo-sdk
          </a>
          .
        </p>
      </section>
    </div>
  );
}
