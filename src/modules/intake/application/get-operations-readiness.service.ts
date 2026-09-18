import { AppError } from "../../../shared/errors/app-error.js";
import {
  evaluateOperationsReadiness,
  type OperationsReadinessSnapshot as PolicySnapshot,
} from "../domain/operations-readiness.policy.js";
import type { OperationsReadinessSnapshot } from "../repository/intake.repository.js";

export interface OperationsReadinessRepository {
  getOperationsReadiness(
    caseId: string,
  ): Promise<OperationsReadinessSnapshot | null>;
}

export class GetOperationsReadinessService {
  public constructor(
    private readonly repository: OperationsReadinessRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  public async execute(caseId: string) {
    const snapshot = await this.repository.getOperationsReadiness(caseId);
    if (!snapshot)
      throw new AppError({
        code: "intake.case_not_found",
        title: "Intake case not found",
        status: 404,
        detail: "The requested intake case does not exist.",
      });
    const evaluatedAt = this.clock();
    const result = evaluateOperationsReadiness(
      snapshot as PolicySnapshot,
      evaluatedAt,
    );
    return {
      data: { ...result.data, evaluated_at: evaluatedAt.toISOString() },
    };
  }
}
