import { defineConfig } from "vitest/config";

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
  },
});
