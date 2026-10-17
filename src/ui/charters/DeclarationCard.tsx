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
      return `${declaration.identities.length} appointed moderator(s) moderate it.`;
    case 'unknown':
      return `It declares a moderation kind this site does not know (${declaration.rawType}).`;
  }
}

function electionDelayText(delaySeconds: number | undefined, opensAt: number | undefined): string {
  if (!delaySeconds) return 'none: teams can apply at once';
  const base = `${durationText(delaySeconds)} after the contract was created`;
  if (opensAt === Number.POSITIVE_INFINITY) return `${base} (no creation time recorded: the election never opens)`;
  if (opensAt) return `${base} (applications open ${new Date(opensAt).toLocaleString()})`;
  return base;
}

/** What a contract's elected declaration says, in plain words. */
export function DeclarationCard({ moderation }: { moderation: ContractModeration }) {
  const { declaration, lists } = moderation;
  if (declaration.kind !== 'elected') {
    return (
      <section className="charter-card">
        <h2 className="section-title">Not an elected contract</h2>
        <p>
          {notElectedText(declaration)} Moderator elections only exist for contracts that declare elected
          moderation, so no team can apply here.
        </p>
      </section>
    );
  }
  const e = declaration.elected;
  const opensAt = electionOpensAtMs(moderation);
  const kept = (['banlist', 'suspensions', 'warnings'] as const).filter((l) => lists[l]);
  return (
    <section className="charter-card">
      <h2 className="section-title">What the contract declares</h2>
      <dl className="kv-table">
        <div>
          <dt className="mono-label">join window</dt>
          <dd>{durationText(e.joinWindowSeconds)} from the first application</dd>
        </div>
        <div>
          <dt className="mono-label">vote window</dt>
          <dd>{durationText(e.voteWindowSeconds)} more once a second team applies</dd>
        </div>
        <div>
          <dt className="mono-label">election delay</dt>
          <dd>{electionDelayText(e.electionDelaySeconds, opensAt)}</dd>
        </div>
        <div>
          <dt className="mono-label">until seated</dt>
          <dd>
            {INTERIM_TEXT[e.interim.kind]}
            {e.interim.identities.length > 0 && ` (${e.interim.identities.length})`}
          </dd>
        </div>
        <div>
          <dt className="mono-label">moderated types</dt>
          <dd>
            {Object.entries(e.moderatedDocumentTypes)
              .map(([type, abilities]) => `${type}: ${abilities.join(', ')}`)
              .join(' · ') || 'none listed'}
          </dd>
        </div>
        <div>
          <dt className="mono-label">lists kept</dt>
          <dd>{kept.length > 0 ? kept.join(', ') : 'none'}</dd>
        </div>
        <div>
          <dt className="mono-label">members added later</dt>
          <dd>at most {e.maxAddedModerators} at a time</dd>
        </div>
        <div>
          <dt className="mono-label">owner protected</dt>
          <dd>{e.ownerProtected ? 'yes: the team cannot act against the owner' : 'no'}</dd>
        </div>
        <div>
          <dt className="mono-label">seat contestable</dt>
          <dd>
            {e.seatContestable ? 'declared yes' : 'declared no'}; on protocol 14 a seat is permanent either way
          </dd>
        </div>
      </dl>
    </section>
  );
}
