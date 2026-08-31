export interface AuthContext {
  accountId: string;
  providerSessionId: string;
  population: "customer" | "staff_partner";
}
