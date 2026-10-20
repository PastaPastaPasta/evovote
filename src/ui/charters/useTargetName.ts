import { useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { resolveTargetName, targetName } from '../../kinds/charter';

/**
 * A contract's name (`targetName`), re-rendered once the owner's name of a
 * contract the site has no name for has been read.
 */
export function useTargetName(sdk: EvoSDK | undefined, targetContractId: string): string {
  const [resolved, setResolved] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    void resolveTargetName(sdk, targetContractId).then((name) => {
      if (!cancelled) setResolved({ id: targetContractId, name });
    });
    return () => {
      cancelled = true;
    };
  }, [sdk, targetContractId]);
  return resolved?.id === targetContractId ? resolved.name : targetName(targetContractId);
}
