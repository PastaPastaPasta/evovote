import { describeIndex } from '../../kinds/generic';
import type { ContestedIndex } from '../../discovery/contracts';

/** A contested index's rules in plain words: description, voting rule, field filter. */
export function IndexRules({ index }: { index: ContestedIndex }) {
  return (
    <ul className="index-rules">
      <li className="mono-label">
        index <span className="mono">{index.indexName}</span> on{' '}
        <span className="mono">{index.properties.join(', ') || '?'}</span>
      </li>
      {describeIndex(index).map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}
