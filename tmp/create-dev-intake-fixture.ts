import { createPrismaClient } from "/app/dist/infrastructure/database/prisma.js";

const database = createPrismaClient(process.env.DATABASE_URL ?? "postgresql://prisma:prisma@localhost:5432/vistablox");
const accountId = "acct_01M2MPJWK6NSHR52J2BMPESR0R";
const caseId = "case_dev_zagreb_full_fixture";
const propertyId = "property_dev_zagreb_full_fixture";
const revisionId = "revision_dev_zagreb_full_fixture";
const pivId = "piv_dev_zagreb_full_fixture";
const offeringId = "offering_dev_zagreb_full_fixture";
const packId = "pack_dev_zagreb_full_fixture";
const legalId = "legal_dev_fixture";
const appraisalId = "appraisal_dev_fixture";
const porto = {
  caseId: "case_dev_porto_ipo_fixture",
  propertyId: "property_dev_porto_ipo_fixture",
  revisionId: "revision_dev_porto_ipo_fixture",
  pivId: "piv_dev_porto_ipo_fixture",
  offeringId: "offering_dev_porto_ipo_fixture",
  packId: "pack_dev_porto_ipo_fixture",
};
const now = new Date("2026-09-17T12:00:00.000Z");
const ref = (name: string) => `intake/dev/${caseId}/${name}`;

async function main(): Promise<void> {
await database.$transaction(async (tx) => {
  await tx.intakeCase.deleteMany({ where: { id: { in: [caseId, porto.caseId] } } });
  await tx.legalPractice.deleteMany({ where: { id: legalId } });
  await tx.appraisalFirm.deleteMany({ where: { id: appraisalId } });
  await tx.legalPractice.create({ data: { id: legalId, name: "Development Legal Practice", countryCode: "HR" } });
  await tx.appraisalFirm.create({ data: { id: appraisalId, name: "Development Appraisal Firm", countryCode: "HR" } });
  await tx.property.create({ data: {
    id: propertyId, countryCode: "HR", city: "Zagreb", addressLine: "Ilica 12, Apartment 4",
    landRegistryReference: "DEV-HR-ZG-ILICA-12", ownerDeclaredValueEur: "285000.00",
    hasExistingEncumbrance: false, residentialSubtype: "apartment", livingAreaSqM: "118.50",
    bedrooms: 3, bathrooms: 2, floor: 2, totalFloors: 3, yearBuilt: 2018, condition: "good", energyRating: "B",
    rooms: { create: [
      { id: "room_dev_bed_1", roomType: "bedroom", sizeSqM: "16.20" },
      { id: "room_dev_bed_2", roomType: "bedroom", sizeSqM: "13.80" },
      { id: "room_dev_bed_3", roomType: "bedroom", sizeSqM: "11.40" },
      { id: "room_dev_bath_1", roomType: "bathroom", sizeSqM: "6.10" },
      { id: "room_dev_bath_2", roomType: "bathroom", sizeSqM: "4.80" },
      { id: "room_dev_living", roomType: "living_room", sizeSqM: "32.50" },
      { id: "room_dev_kitchen", roomType: "kitchen", sizeSqM: "12.60" },
      { id: "room_dev_office", roomType: "office", sizeSqM: "9.20" },
    ] },
  } });
  await tx.intakeCase.create({ data: {
    id: caseId, propertyId, applicantAccountId: accountId, stage: "approved_for_final_offering",
    legalPracticeId: legalId, appraisalFirmId: appraisalId,
    legalStructuringCompletedAt: new Date("2026-09-12T10:00:00.000Z"), appraisalCompletedAt: new Date("2026-09-13T10:00:00.000Z"),
    postIpoStructuringCompletedAt: new Date("2026-09-14T10:00:00.000Z"), approvedForFinalOfferingAt: new Date("2026-09-10T12:00:00.000Z"),
    founderReviewNotes: "Development fixture - fully completed sample case.", reviewedByAccountId: accountId,
    approvedAt: new Date("2026-09-10T12:00:00.000Z"), ipoPeriodDays: 30, ipoEndAt: new Date("2026-10-01T00:00:00.000Z"), ipoValueEur: "250000.00",
    legalExecutionEventRefs: [], legalDocumentRefs: [ref("ownership-declaration.pdf")], appraisalDocumentRefs: [ref("appraisal-report.pdf")],
  } });
  await tx.submissionRevision.create({ data: { id: revisionId, caseId, revisionNumber: 1, submittedAt: new Date("2026-09-08T12:00:00.000Z"), submittedByAccountId: accountId, submissionData: { development_fixture: true }, reason: "initial" } });
  await tx.intakeCase.update({ where: { id: caseId }, data: { currentSubmissionRevisionId: revisionId } });
  for (const [id, type, filename] of [
    ["evidence_dev_ownership", "ownership_declaration", "ownership-declaration.pdf"],
    ["evidence_dev_facts", "property_facts_sheet", "property-facts-sheet.pdf"],
    ["evidence_dev_encumbrance", "encumbrance_declaration", "encumbrance-declaration.pdf"],
    ["evidence_dev_photos", "photo_set", "property-exterior.png"],
  ]) await tx.documentaryScreeningEvidence.create({ data: { id, caseId, submissionRevisionId: revisionId, documentType: type, status: "accepted", documentRef: ref(filename), uploadedAt: new Date("2026-09-08T12:30:00.000Z"), reviewedByAccountId: accountId, reviewedAt: new Date("2026-09-09T12:30:00.000Z"), reviewNotes: "Development fixture accepted." } });
  await tx.piv.create({ data: { id: pivId, propertyId, caseId, legalName: "Ilica 12 Residential PIV d.o.o.", jurisdiction: "HR", registrationNo: "DEV-HR-00012", incorporatedAt: new Date("2026-09-14T12:00:00.000Z"), deedTransferStatus: "completed" } });
  await tx.offering.create({ data: { id: offeringId, pivId, minimumRaiseEur: "100000.00", targetRaiseEur: "250000.00", status: "pre_offering", createdAt: new Date("2026-09-15T12:00:00.000Z"), disclosurePacks: { create: { id: packId, version: 1, publishedAt: new Date("2026-09-15T12:00:00.000Z"), isCurrent: true, documents: { create: ["ecsp_kiis","priips_kid","final_offer_summary","final_terms_sheet","issuer_offeror_structure_sheet","investor_rights_payout_waterfall_summary","risk_factors_summary","property_appraisal_summary","fees_costs_tax_liquidity_summary","withdrawal_cancellation_supplement_rights_notice","full_prospectus"].map((type, i) => ({ id: `disclosure_dev_${i}`, documentType: type, documentRef: ref("property-facts-sheet.pdf") })) } } } } });
  for (const [id, amount, stage] of [["reservation_dev_1", "100000.00", "finalized"], ["reservation_dev_2", "150000.00", "reconfirmed"], ["reservation_dev_3", "50000.00", "cancelled"] as const]) {
    await tx.reservation.create({ data: { id, offeringId, accountId, amountEur: amount, reservationStage: stage, createdAt: new Date("2026-09-16T12:00:00.000Z"), moneyEvents: { create: { id: `${id}_money`, provider: "development_fixture", providerReference: `${id}-payment`, capitalState: stage === "cancelled" ? "eurc_cancelled" : "eurc_finalized", amountEur: amount, recordedAt: new Date("2026-09-16T13:00:00.000Z") } } } });
  }

  // A separate, intentionally open IPO fixture. It is distinct from the
  // completed Zagreb listing above so the mobile app can exercise both
  // discovery and investment-ready states without manufacturing production
  // data. These IDs are the only ones with local editorial imagery in mobile.
  await tx.property.create({ data: {
    id: porto.propertyId, countryCode: "PT", city: "Porto", addressLine: "Rua da Foz 42",
    landRegistryReference: "DEV-PT-PT-FOZ-42", ownerDeclaredValueEur: "620000.00",
    hasExistingEncumbrance: false, residentialSubtype: "apartment", livingAreaSqM: "146.00",
    bedrooms: 3, bathrooms: 2, floor: 3, totalFloors: 5, yearBuilt: 2021, condition: "excellent", energyRating: "A",
  } });
  await tx.intakeCase.create({ data: {
    id: porto.caseId, propertyId: porto.propertyId, applicantAccountId: accountId, stage: "pre_offering_open",
    legalPracticeId: legalId, appraisalFirmId: appraisalId,
    approvedAt: new Date("2026-09-16T12:00:00.000Z"), ipoPeriodDays: 30,
    ipoEndAt: new Date("2026-10-18T00:00:00.000Z"), ipoValueEur: "500000.00",
    founderReviewNotes: "Development fixture - open IPO sample case.", reviewedByAccountId: accountId,
    legalExecutionEventRefs: [], legalDocumentRefs: [ref("ownership-declaration.pdf")], appraisalDocumentRefs: [ref("appraisal-report.pdf")],
  } });
  await tx.submissionRevision.create({ data: {
    id: porto.revisionId, caseId: porto.caseId, revisionNumber: 1,
    submittedAt: new Date("2026-09-14T12:00:00.000Z"), submittedByAccountId: accountId,
    submissionData: { development_fixture: true }, reason: "initial",
  } });
  await tx.intakeCase.update({ where: { id: porto.caseId }, data: { currentSubmissionRevisionId: porto.revisionId } });
  await tx.piv.create({ data: {
    id: porto.pivId, propertyId: porto.propertyId, caseId: porto.caseId,
    legalName: "Harbour View Apartments PIV, Lda.", jurisdiction: "PT", registrationNo: "DEV-PT-00042",
    incorporatedAt: new Date("2026-09-16T12:00:00.000Z"), deedTransferStatus: "completed",
  } });
  await tx.offering.create({ data: {
    id: porto.offeringId, pivId: porto.pivId, minimumRaiseEur: "1000.00", targetRaiseEur: "500000.00",
    status: "pre_offering", createdAt: new Date("2026-09-17T12:00:00.000Z"),
    disclosurePacks: { create: {
      id: porto.packId, version: 1, publishedAt: new Date("2026-09-17T12:00:00.000Z"), isCurrent: true,
      documents: { create: ["ecsp_kiis", "priips_kid", "final_offer_summary", "final_terms_sheet", "issuer_offeror_structure_sheet", "investor_rights_payout_waterfall_summary", "risk_factors_summary", "property_appraisal_summary", "fees_costs_tax_liquidity_summary", "withdrawal_cancellation_supplement_rights_notice", "full_prospectus"].map((type, i) => ({ id: `disclosure_porto_${i}`, documentType: type, documentRef: ref("property-facts-sheet.pdf") })) },
    } },
  } });
});
console.log(JSON.stringify({
  listing: { caseId, propertyId, pivId, offeringId, packId },
  ipo: porto,
}));
await database.$disconnect();
}

void main();
