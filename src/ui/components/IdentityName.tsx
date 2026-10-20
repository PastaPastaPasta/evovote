import { useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchUsernames } from '../../kinds/dpns';
import { shortId } from '../format';

/** An identity as its first DPNS name (best effort), with the id on hover. */
export function IdentityName({ sdk, id }: { sdk: EvoSDK; id: string }) {
  // Keyed by id, so a reused element never shows the previous identity's name.
  const [resolved, setResolved] = useState<{ id: string; name?: string }>();
  const name = resolved?.id === id ? resolved.name : undefined;
  useEffect(() => {
    let cancelled = false;
    void fetchUsernames(sdk, id).then((names) => {
      if (!cancelled) setResolved({ id, name: names[0] });
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, id]);
  return (
    <span className="identity-name" title={id}>
      {name ? <strong>{name}</strong> : <span className="mono">{shortId(id)}</span>}
    </span>
  );
}
