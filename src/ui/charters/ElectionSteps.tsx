/**
 * How a team gets a seat, and what each step costs, before anyone starts.
 * Fees are typical testnet amounts (docs/V2_NOTES.md); every paid step shows
 * its own estimate and the balance before anything is signed.
 */
export function ElectionSteps() {
  return (
    <ol className="election-steps">
      <li>
        <strong>File the reasons your team may act on</strong>
        <span>Spam, off-topic, abuse… Each one is a small fee, about 0.0004 DASH.</span>
      </li>
      <li>
        <strong>File your charter</strong>
        <span>
          What you would moderate, how, and how fees are shared. About 0.0005 DASH, plus up to 0.001 DASH once to add a
          key for reading join requests.
        </span>
      </li>
      <li>
        <strong>People ask to join your team</strong>
        <span>Free for you. Share your proposal; each person pays their own small fee.</span>
      </li>
      <li>
        <strong>Apply for the seat</strong>
        <span>
          <b>0.5 DASH</b> contest fund plus about 0.0005 DASH in fees. The fund pays for the masternode vote and is
          not refunded, win or lose.
        </span>
      </li>
    </ol>
  );
}
