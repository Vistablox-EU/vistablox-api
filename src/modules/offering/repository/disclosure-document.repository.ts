export interface AccessibleDisclosureDocumentRecord {
  documentReference: string;
  documentType: string;
  disclosurePackVersion: number;
}

export interface DisclosureDocumentRepository {
  getAccessibleDocument(input: {
    accountId: string;
    offeringId: string;
    documentId: string;
  }): Promise<AccessibleDisclosureDocumentRecord | null>;
}
