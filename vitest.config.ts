import { defineConfig } from "vitest/config";

// Test files run in parallel against one database. The first-admin bootstrap
// suite's "issued" cases only pass while no account in that database holds an
// active admin_operations role, and other suites (account recovery, staff
// account lifecycle, staff WebAuthn) create such accounts while they run. So it
// runs on its own, in a group that starts after every other test file has
// finished.
const bootstrapSuite = "tests/staff-bootstrap-repository.integration.test.ts";
// The pending-wallet-claim expiry sweep is global, and its stale fixtures are
// older than any other suite's pending claims (the wallet registry health
// suite asserts which pending claim is the oldest). So it also runs on its own,
// after the parallel files and before the bootstrap suite.
const walletExpirySuite = "tests/wallet-claim-expiry.integration.test.ts";

export default defineConfig({
  test: {
    environment: "node",
    // contracts/ is a self-contained Hardhat/Mocha package with its own
    // test runner (npm run contracts:test) -- vitest's default discovery
    // would otherwise also pick up its *.test.js files and fail to run them.
    // .claude/ holds Claude Code worktrees -- full copies of this repo whose
    // tests would otherwise run a second time alongside the real suite.
    exclude: ["**/node_modules/**", "contracts/**", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
    // Both projects inherit the options above; an exclude list given here is
    // added to the one above rather than replacing it.
    projects: [
      { extends: true, test: { name: "parallel", exclude: [bootstrapSuite, walletExpirySuite] } },
      {
        extends: true,
        test: { name: "wallet-expiry-alone", include: [walletExpirySuite], sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: { name: "bootstrap-alone", include: [bootstrapSuite], sequence: { groupOrder: 2 } },
      },
    ],
  },
});
