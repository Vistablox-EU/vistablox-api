// The platform.settings rows the wallet-registry watcher keeps. Named once so
// the repository that writes the cursor and the one that reads the watcher's
// history cannot disagree about which rows they mean.

// The last block the watcher processed. Written by PrismaSettlementRepository.
export const WALLET_REGISTRY_CURSOR_SETTING_KEY = "wallet_registry.last_processed_block";

// When the watcher last completed a run, and the cursor and safe head it saw
// then. Written by PrismaWalletRegistryHealthRepository.
export const WALLET_REGISTRY_HEARTBEAT_SETTING_KEY = "wallet_registry.watcher_heartbeat";
