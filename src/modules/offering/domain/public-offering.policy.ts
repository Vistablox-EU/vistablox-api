export const publicOfferingStatuses = ["pre_offering", "final_offering"] as const;

export type PublicOfferingStatus = (typeof publicOfferingStatuses)[number];

export function isPublicOfferingStatus(status: string): status is PublicOfferingStatus {
  return publicOfferingStatuses.some((publicStatus) => publicStatus === status);
}
