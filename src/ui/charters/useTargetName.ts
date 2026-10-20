import { useEffect, useSyncExternalStore } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { resolveTargetName, subscribeTargetNames, targetName, targetNamesVersion } from '../../kinds/charter';

/** Re-renders whenever some contract's `targetName` changes (an owner's name was read). */
export function useTargetNames(): void {
  useSyncExternalStore(subscribeTargetNames, targetNamesVersion, targetNamesVersion);
}

/**
 * A contract's name (`targetName`), re-rendered once the owner's name of a
 * contract the site has no name for has been read.
 */
export function useTargetName(sdk: EvoSDK | undefined, targetContractId: string): string {
  useTargetNames();
  useEffect(() => {
    if (sdk && targetContractId) void resolveTargetName(sdk, targetContractId);
  }, [sdk, targetContractId]);
  return targetName(targetContractId);
}
