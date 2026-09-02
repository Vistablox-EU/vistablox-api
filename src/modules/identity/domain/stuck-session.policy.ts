/**
 * docs/didit-kyc.md's follow-on-work gap: a session start can get
 * permanently wedged in kyc_session_creating/kyc_session_open (or the
 * proof-of-address equivalents) with no self-service recovery path, since
 * canStartSession/canStartProofOfAddress (prisma-kyc.repository.ts)
 * exclude both substatuses from their retry allow-list. Two distinct
 * timeouts share this one elapsed-time check: a short one for *_creating
 * (nothing user-facing happens in that window — reserveSessionStart and
 * completeSessionStart/failSessionStart run back to back within the same
 * request, so anything beyond a few minutes is a crash, never a
 * legitimately slow one) and a much longer one for *_open/in_progress
 * (a live Didit session genuinely exists there and the customer may still
 * be actively completing it).
 */
export function isSessionStuck(input: { updatedAt: Date; now: Date; timeoutMs: number }): boolean {
  return input.now.getTime() - input.updatedAt.getTime() >= input.timeoutMs;
}
