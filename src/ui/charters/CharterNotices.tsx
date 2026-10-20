/** The two rules every moderator election shows next to its contest. */
export function CharterNotices() {
  return (
    <ul className="charter-notices">
      <li>
        <strong>A win is permanent.</strong> On protocol 14 the winning team keeps this seat for good: no other
        team can apply afterwards, and nobody can challenge it yet.
      </li>
      <li>
        <strong>There is always a winner.</strong> Masternodes cannot block the seat. A tie goes to the team that
        applied first, and a team that applies alone wins when the join window closes.
      </li>
    </ul>
  );
}
