/**
 * The chain could not be read (RPC failure, timeout, unknown or non-canonical
 * block). Distinct from a contract revert, which is an answer from the chain,
 * not a failure to get one. The message is built from viem's `shortMessage`
 * only, because viem's `message` and `cause.message` embed the RPC URL, which
 * can carry a provider API key. No `cause` is attached for the same reason.
 */
export class ChainStateUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChainStateUnavailableError";
  }
}
