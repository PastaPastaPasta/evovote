/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public contract ids of the discussion contract (never put secrets in VITE_*). */
  readonly VITE_DISCUSSION_TESTNET_CONTRACT_ID?: string;
  readonly VITE_DISCUSSION_MAINNET_CONTRACT_ID?: string;
}
