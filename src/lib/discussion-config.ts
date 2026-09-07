import type { Network } from './sdk';

// Set only after publishing and verifying the contract on the corresponding network.
const contracts: Record<Network, string> = {
  mainnet: import.meta.env.VITE_DISCUSSION_MAINNET_CONTRACT_ID ?? '',
  testnet: import.meta.env.VITE_DISCUSSION_TESTNET_CONTRACT_ID ?? '',
};
const exchanges: Record<Network, string> = {
  mainnet: import.meta.env.VITE_KEY_EXCHANGE_MAINNET_CONTRACT_ID ?? '',
  testnet: import.meta.env.VITE_KEY_EXCHANGE_TESTNET_CONTRACT_ID ?? '',
};
export const discussionContract = (network: Network): string => contracts[network];
export const keyExchangeContract = (network: Network): string => exchanges[network];
