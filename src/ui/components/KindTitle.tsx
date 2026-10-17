import { dpnsDisplayLabel } from '../../kinds/dpns';
import { kindFor } from '../../kinds/registry';
import type { Contest, ContestSummary } from '../../model/contest';
import { ContestedName } from './ContestedName';

/**
 * A contest's title. Usernames keep v1's look (homograph characters tinted,
 * optional `.dash`); every other kind renders its adapter's plain title.
 */
export function KindTitle({
  contest,
  tld = false,
}: {
  contest: ContestSummary | Contest;
  tld?: boolean;
}) {
  const kind = kindFor(contest.key);
  if (kind.id === 'dpns') {
    return (
      <>
        <ContestedName label={dpnsDisplayLabel(contest)} />
        {tld && <span className="tld">.dash</span>}
      </>
    );
  }
  return <span className="kind-title">{kind.title(contest)}</span>;
}
