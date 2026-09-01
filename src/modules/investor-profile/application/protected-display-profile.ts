export interface ProtectedDisplayProfile {
  givenName: string;
  familyName: string;
  fullDisplayName: string;
  syncedAt: Date;
}

export interface ProtectedDisplayProfileProvider {
  get(input: {
    accountId: string;
    diditReference: string | null;
    providerStatus: string | null;
  }): Promise<ProtectedDisplayProfile | null>;
}
