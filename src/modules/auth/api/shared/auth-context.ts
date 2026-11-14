export interface AuthContext {
  accountId: string;
  providerSessionId: string;
  population: "customer" | "staff_partner";
  authenticationLevel?: string;
  sessionCreatedAt?: Date;
  /**
   * The DPoP key this session is bound to (contract 3.1). Only present on
   * sessions that presented a fresh, matching proof and are therefore
   * device-bound; signing actions resolve the device from it.
   */
  dpopJkt?: string;
}
