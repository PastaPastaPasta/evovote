import { dateText } from '../format';
import {
  durationText,
  electionOpensAtMs,
  INTERIM_TEXT,
  type ContractModeration,
  type ModerationDeclaration,
} from '../../charters/declaration';

function notElectedText(declaration: Exclude<ModerationDeclaration, { kind: 'elected' }>): string {
  switch (declaration.kind) {
    case 'none':
      return 'This contract declares no moderation.';
    case 'contractOwner':
      return 'Its owner moderates it.';
    case 'appointedModerators':
      return `${declaration.identities.length === 1 ? 'One appointed moderator moderates' : `${declaration.identities.length} appointed moderators moderate`} it.`;
    case 'unknown':
      return `It declares a moderation kind this site does not know (${declaration.rawType}).`;
  }
}

function electionDelayText(delaySeconds: number | undefined, opensAt: number | undefined): string {
  if (!delaySeconds) return 'None: teams can apply as soon as the contract exists';
  const base = `${durationText(delaySeconds)} after the contract was created`;
  if (opensAt === Number.POSITIVE_INFINITY) return `${base}. The contract has no recorded creation time, so its election never opens.`;
  if (opensAt) return `${base} (${opensAt > Date.now() ? 'opens' : 'opened'} ${dateText(opensAt)})`;
  return base;
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const ABILITY_TEXT: Record<string, string> = {
  deleteDocuments: 'delete',
  ban: 'ban',
  suspend: 'suspend',
  warn: 'warn',
  changeDocumentFields: 'edit fields',
};

/** "post (delete, ban, suspend, warn)". */
export function moderatedTypesText(types: Record<string, string[]>): string {
  return (
    Object.entries(types)
      .map(([type, abilities]) => `${type} (${abilities.map((a) => ABILITY_TEXT[a] ?? a).join(', ')})`)
      .join(' · ') || 'none listed'
  );
}

/**
 * What a contract's moderation declaration says, in plain words: the rules
 * its election runs by. The hub shows it collapsed under "Contract rules".
 */
export function DeclarationCard({ moderation }: { moderation: ContractModeration }) {
  const { declaration, lists } = moderation;
  if (declaration.kind !== 'elected') {
    return (
      <p>
        {notElectedText(declaration)} Moderator elections only exist for contracts that declare elected
        moderation, so no team can apply here.
      </p>
    );
  }
  const e = declaration.elected;
  const opensAt = electionOpensAtMs(moderation);
  const kept = (['banlist', 'suspensions', 'warnings'] as const).filter((l) => lists[l]);
  return (
    <dl className="kv-table">
      <div>
        <dt>What the team moderates</dt>
        <dd>{moderatedTypesText(e.moderatedDocumentTypes)}</dd>
      </div>
      <div>
        <dt>Joining the race</dt>
        <dd>Other teams have {durationText(e.joinWindowSeconds)} after the first application to apply too</dd>
      </div>
      <div>
        <dt>Voting</dt>
        <dd>
          Once a second team applies, masternodes get {durationText(e.voteWindowSeconds)} more to vote. A team that
          applies alone wins when the join window closes.
        </dd>
      </div>
      <div>
        <dt>Election delay</dt>
        <dd>{electionDelayText(e.electionDelaySeconds, opensAt)}</dd>
      </div>
      <div>
        <dt>Until a team is seated</dt>
        <dd>
          {cap(INTERIM_TEXT[e.interim.kind])}
          {e.interim.identities.length > 0 && ` (${e.interim.identities.length})`}
        </dd>
      </div>
      <div>
        <dt>Lists the team keeps</dt>
        <dd>{kept.length > 0 ? cap(kept.join(', ')) : 'None'}</dd>
      </div>
      <div>
        <dt>Members added later</dt>
        <dd>At most {e.maxAddedModerators} at a time</dd>
      </div>
      <div>
        <dt>Contract owner</dt>
        <dd>{e.ownerProtected ? 'Protected: the team cannot act against the owner' : 'Not protected'}</dd>
      </div>
      <div>
        <dt>Can the seat be challenged?</dt>
        <dd>
          No. The contract {e.seatContestable ? 'asks for challenges' : 'does not ask for challenges'}, but on
          protocol 14 a seat is permanent either way.
        </dd>
      </div>
    </dl>
  );
}
