import { useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchUsernames } from '../../kinds/dpns';
import { shortId } from '../format';

/** An identity as its first DPNS name (best effort), with the id on hover. */
export function IdentityName({ sdk, id }: { sdk: EvoSDK; id: string }) {
  const [name, setName] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    void fetchUsernames(sdk, id).then((names) => {
      if (!cancelled) setName(names[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, id]);
  return (
    <span className="identity-name" title={id}>
      {name ? <strong>{name}</strong> : <span className="mono">{shortId(id, 6)}</span>}
    </span>
  );
}
