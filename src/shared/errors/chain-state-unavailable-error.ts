/**
 * The chain could not be read (RPC failure, timeout, unknown or non-canonical
 * block). Distinct from a contract revert, which is an answer from the chain,
 * not a failure to get one. The message is built from viem's class name and
 * `shortMessage` plus the numeric JSON-RPC code or HTTP status, because viem's
 * `message` and `cause.message` embed the RPC URL, which can carry a provider
 * API key. No `cause` is attached for the same reason. The message is what an
 * operator reads in the log: the service attaches this error as the `cause` of
 * the 503, so it must stay free of URLs, keys and the node's own text.
 */
export class ChainStateUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChainStateUnavailableError";
  }
}
