import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testsDirectory, "..");
const bootstrapSuite = "tests/staff-bootstrap-repository.integration.test.ts";

// The bootstrap suite's "issued" cases only pass while no account in the shared
// test database holds an active admin_operations role, and other suites
// create one for the length of their run. Vitest runs test files in
// parallel, so vitest.config.ts runs the bootstrap suite on its own, after
// every other file has finished. This reads the configuration the way Vitest
// resolves it, so an edit that stops the suite running alone fails here
// instead of showing up as an occasional red build.
describe("first-admin bootstrap suite isolation", () => {
  it("runs the bootstrap suite alone, after every other test file", async () => {
    const vitest = await createVitest("test", {
      watch: false,
      root: repositoryRoot,
      reporters: [],
    });
    try {
      const specifications = await vitest.globTestSpecifications();
      const placements = specifications.map((specification) => ({
        file: relative(repositoryRoot, specification.moduleId).split("\\").join("/"),
        project: specification.project.name,
        groupOrder: specification.project.config.sequence.groupOrder,
      }));
      const bootstrap = placements.filter((placement) => placement.file === bootstrapSuite);
      expect(bootstrap).toHaveLength(1);
      const [alone] = bootstrap;
      const others = placements.filter((placement) => placement.file !== bootstrapSuite);

      // The projects add their own exclude to the root one rather than
      // replacing it: nothing from the directories vitest.config.ts excludes
      // (contracts/ has its own runner) is picked up.
      const excludedDirectories = /^(contracts|\.claude)\/|(^|\/)node_modules\//;
      expect(placements.filter((placement) => excludedDirectories.test(placement.file))).toEqual([]);

      // It has a project to itself...
      const sharingItsProject = others.filter((placement) => placement.project === alone?.project);
      expect(sharingItsProject.length, "other test files in the bootstrap suite's project").toBe(0);
      // ...which only starts once every other project has finished.
      const lastOtherGroup = Math.max(...others.map((placement) => placement.groupOrder));
      expect(alone?.groupOrder).toBeGreaterThan(lastOtherGroup);
    } finally {
      await vitest.close();
    }
  }, 30_000);
});
