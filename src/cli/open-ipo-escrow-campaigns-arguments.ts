import { parseArgs } from "node:util";

export const OPEN_IPO_ESCROW_CAMPAIGNS_USAGE = `Usage:
  npm run settlement:open-ipo-escrow-campaigns
  npm run settlement:open-ipo-escrow-campaigns -- --confirm

Opens the IPO escrow campaign of every offering that is still open for
reservations and whose IPO deadline (ipo_end_at) is ahead, and records what the
chain shows, which is what lets that offering take reservations (AD-286,
docs/investor-offering.md). Without --confirm it is a dry run: it reads the
chain and the database, prints what it would open or record for each offering,
and changes nothing.

It refuses unless the settlement bundle is configured and CHAIN_NETWORK is
base-sepolia (AD-234). Every campaign gets the single PIV_TREASURY_ADDRESS as
its treasury: the per-PIV treasury (C-008 question 3) is not decided.

A campaign that already exists on-chain with another target, deadline, treasury
or escrow contract than the offering's is not adopted: it is reported, logged
as settlement.ipo_escrow_campaign_mismatch, and the exit code is 1. So is a
campaign that is already Successful or Failed, and any offering that fails.
Offerings are handled one at a time; one failing does not stop the next.

  --confirm  open the campaigns (sends transactions signed by the operator key)
  --help     show this help

Exit codes: 0 every offering is fine (or nothing to do), 1 refused, or any
offering failed or needs manual action, 2 bad arguments.`;

export type OpenIpoEscrowCampaignsArguments = { mode: "help" } | { mode: "dry_run" | "confirm" };

export type ParsedOpenIpoEscrowCampaignsArguments =
  | { ok: true; value: OpenIpoEscrowCampaignsArguments }
  | { ok: false; error: string };

export function parseOpenIpoEscrowCampaignsArguments(argv: string[]): ParsedOpenIpoEscrowCampaignsArguments {
  let values: { confirm?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        confirm: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid arguments" };
  }

  if (values.help === true) return { ok: true, value: { mode: "help" } };
  return { ok: true, value: { mode: values.confirm === true ? "confirm" : "dry_run" } };
}
