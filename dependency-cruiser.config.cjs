/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "routes-must-not-import-repositories",
      severity: "error",
      from: { path: "src/modules/.+/api" },
      to: { path: "src/modules/.+/repository" },
    },
    {
      name: "domain-must-stay-pure",
      severity: "error",
      from: { path: "src/modules/.+/domain" },
      to: { path: "src/(infrastructure|shared/http)|src/modules/.+/(api|application|repository)" },
    },
    {
      name: "no-cross-domain-internals",
      severity: "error",
      from: { path: "src/modules/([^/]+)" },
      to: { path: "src/modules/(?!$1)[^/]+/(domain|application|repository)" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"] },
    reporterOptions: { dot: { collapsePattern: "node_modules/[^/]+" } },
  },
};
