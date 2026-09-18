/** Stable storage boundaries. Buckets represent security/retention boundaries;
 * document types are represented by prefixes and database metadata. */
export const DEFAULT_STORAGE_BUCKETS = {
  quarantine: "vistablox-quarantine",
  private: "vistablox-private",
  kyc: "vistablox-kyc",
  disclosures: "vistablox-disclosures",
  audit: "vistablox-audit",
} as const;

export type StorageBucketName = keyof typeof DEFAULT_STORAGE_BUCKETS;

export function objectKey(input: {
  area: "intake" | "kyc" | "offerings" | "audit";
  subjectId: string;
  documentId: string;
  revision?: number;
}): string {
  const key = [input.area, input.subjectId, input.revision === undefined ? undefined : `revisions/${input.revision}`, input.documentId]
    .filter((part): part is string => part !== undefined).join("/");
  if (!/^[a-z0-9][a-z0-9/_-]{0,511}$/.test(key) || key.includes("..")) throw new Error("Invalid object key components");
  return key;
}
