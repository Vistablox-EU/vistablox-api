type Setting = string | undefined;

export interface SettlementBundleEnvironment {
  CHAIN_NETWORK?: Setting;
  CHAIN_RPC_URL?: Setting;
  CHAIN_OPERATOR_PRIVATE_KEY?: Setting;
  VISTABLOX_PROPERTY_CONTRACT_ADDRESS?: Setting;
  VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS?: Setting;
  EURC_TOKEN_ADDRESS?: Setting;
  PIV_TREASURY_ADDRESS?: Setting;
}

/**
 * Whether the property / IPO-escrow settlement bundle (AD-163, AD-256) is
 * configured: base chain connectivity plus the four contract and treasury
 * addresses, which environment.ts requires all-or-none. AD-234 launches
 * production with it unconfigured, and the worker then neither creates nor
 * consumes the settlement.open_ipo_escrow_campaign queue, so everything that
 * would hand work to that queue (opening an offering) must key on this same
 * answer.
 */
export function isSettlementBundleConfigured(environment: SettlementBundleEnvironment): boolean {
  return (
    environment.CHAIN_NETWORK !== undefined &&
    environment.CHAIN_RPC_URL !== undefined &&
    environment.CHAIN_OPERATOR_PRIVATE_KEY !== undefined &&
    environment.VISTABLOX_PROPERTY_CONTRACT_ADDRESS !== undefined &&
    environment.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS !== undefined &&
    environment.EURC_TOKEN_ADDRESS !== undefined &&
    environment.PIV_TREASURY_ADDRESS !== undefined
  );
}
