import { useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchContestedIndex, type ContestedIndex } from '../../discovery/contracts';
import type { PollKey } from '../../model/pollKey';
import { errorMessage } from '../../sdk/errors';
import { IndexRules } from './IndexRules';

/** The rules of a poll's contested index, read from its contract. */
export function PollIndexInfo({ sdk, pollKey }: { sdk: EvoSDK; pollKey: PollKey }) {
  const [state, setState] = useState<ContestedIndex | 'missing' | { error: string } | undefined>();
  const { contractId, documentTypeName, indexName } = pollKey;

  useEffect(() => {
    let cancelled = false;
    fetchContestedIndex(sdk, contractId, documentTypeName, indexName).then(
      (index) => {
        if (!cancelled) setState(index ?? 'missing');
      },
      (e: unknown) => {
        if (!cancelled) setState({ error: errorMessage(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, contractId, documentTypeName, indexName]);

  if (!state) return null;
  if (state === 'missing') {
    return (
      <p className="mono-label error">
        This contract declares no contested index called “{indexName}” on {documentTypeName}, so
        the voting rule is unknown.
      </p>
    );
  }
  if ('error' in state) {
    return (
      <p className="mono-label error">Could not read this contest’s index rules: {state.error}.</p>
    );
  }
  return (
    <div className="poll-index-info">
      <IndexRules index={state} />
      <p className="mono-label">
        <a href={`#/c/${contractId}`}>Browse this contract’s other contested values</a>
      </p>
    </div>
  );
}
