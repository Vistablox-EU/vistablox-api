import { publicOfferingStatuses, isPublicOfferingStatus } from "../domain/public-offering.policy.js";
import type {
  ListPublicOfferingsInput,
  OfferingRepository,
  PublicOfferingRecord,
} from "./offering.repository.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";

export class PrismaOfferingRepository implements OfferingRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listPublic(input: ListPublicOfferingsInput): Promise<PublicOfferingRecord[]> {
    const rows = await this.database.offering.findMany({
      where: {
        status: { in: [...publicOfferingStatuses] },
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, id: { lt: input.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        status: true,
        targetRaiseEur: true,
        createdAt: true,
        piv: {
          select: {
            case: { select: { ipoEndAt: true } },
            property: {
              select: { propertyType: true, countryCode: true, city: true },
            },
          },
        },
      },
    });

    return rows.map((row) => {
      if (!isPublicOfferingStatus(row.status) || row.piv.property.propertyType !== "residential") {
        throw new Error("Database returned an offering outside the public contract");
      }

      return {
        id: row.id,
        status: row.status,
        targetRaiseEur: row.targetRaiseEur.toFixed(2),
        createdAt: row.createdAt,
        ipoEndAt: row.piv.case.ipoEndAt,
        property: {
          propertyType: row.piv.property.propertyType,
          countryCode: row.piv.property.countryCode,
          city: row.piv.property.city,
        },
      };
    });
  }
}
