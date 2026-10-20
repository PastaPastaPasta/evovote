/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public contract ids of the discussion contract (never put secrets in VITE_*). */
  readonly VITE_DISCUSSION_TESTNET_CONTRACT_ID?: string;
  readonly VITE_DISCUSSION_MAINNET_CONTRACT_ID?: string;
  /** "Sign in with Dash Wallet": the App Connect app id, or `off`; unset means the discussion contract. */
  readonly VITE_APP_CONNECT_APP_ID_TESTNET?: string;
  readonly VITE_APP_CONNECT_APP_ID_MAINNET?: string;
}
