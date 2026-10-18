export function AboutPage() {
  return (
    <div className="about-page">
      <h1>About EvoVote</h1>

      <section>
        <h2>What a contest is</h2>
        <p>
          Any Dash Platform contract can mark one unique index per document type as
          contested. When two identities want the same value, or a value is premium,
          masternodes vote on who gets it. EvoVote shows every such contest it can find:
          usernames, moderator elections, and any other contract&apos;s contested index.
          Everything is read live from Platform with cryptographic proofs.
        </p>
        <p>
          Usernames (DPNS names) are the familiar case: look-alike characters
          (<code>0</code>/<code>o</code>, <code>1</code>/<code>l</code>/<code>i</code>)
          normalize to the same name, so a collision is decided by vote. Masternodes can
          vote for a contender, <strong>abstain</strong>, or, where the contract allows it,
          vote <strong>lock</strong>, which awards the resource to no one. Moderator
          elections have no lock: there is always a winner, and a tie goes to the earliest
          contender.
        </p>
        <p>
          Regular masternodes vote with weight 1, evonodes with weight 4, and each
          masternode may cast up to 5 votes per contest, counting the first. The most
          recent vote is the one that counts.
        </p>
        <p>
          This version targets <strong>testnet</strong> (protocol 14). Mainnet support
          arrives once mainnet runs protocol 14.
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
            ProTxHash plus the voting key hash, and EvoVote checks that
            identity's key against yours before accepting it. No Platform identity
            or credits of your own are needed.
          </li>
        </ol>
        <p>
          The voting key is <em>only</em> the <code>votingAddress</code> key
          from <code>protx info</code>. Owner, operator (BLS), and collateral
          keys are different keys with more power — never paste those anywhere.
        </p>
      </section>

      <section>
        <h2>Why there are no comments</h2>
        <p>
          Masternode voter identities are created automatically by Platform and
          carry a single read-only voting key with no credits, so they cannot
          create documents — which means they cannot post comments or any other
          content. Campaigning for a name happens off-chain: contenders usually
          share their identity ID and requested name on the{' '}
          <a href="https://forum.dash.org" target="_blank" rel="noreferrer">
            Dash forum
          </a>{' '}
          or the Dash Discord.
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
