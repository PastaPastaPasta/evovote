/** The two rules every moderator election shows next to its contest. */
export function CharterNotices() {
  return (
    <ul className="charter-notices">
      <li>
        <strong>The seat is permanent on protocol 14.</strong> Once a team wins, no other team can apply for this
        contract, and challenges do not exist yet.
      </li>
      <li>
        <strong>A tie goes to the earliest application.</strong> There is no Lock: the contest always ends with a
        winner, and a lone applicant wins when the join window closes.
      </li>
    </ul>
  );
}
