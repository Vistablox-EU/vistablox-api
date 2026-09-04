import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Exports just the ABI (never bytecode -- this backend calls already-deployed
// contracts, it never deploys them) from the contracts/ package's Hardhat
// build output into src/, so it's a normal committed file the Docker build
// picks up via its existing `COPY src ./src` -- contracts/ itself is
// deliberately excluded from that build (see contracts/README context: an
// isolated toolchain, kept out of the API/worker's own dependency tree and
// image). Re-run this manually after changing a contract's public interface;
// it is not part of `npm run build`.

const root = path.join(import.meta.dirname, "..");
const CONTRACTS = ["VistaBloxProperty", "VistaBloxIpoEscrow"];

for (const name of CONTRACTS) {
  const artifactPath = path.join(root, "contracts", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const outPath = path.join(root, "src", "infrastructure", "blockchain", "abis", `${name}.abi.json`);
  writeFileSync(outPath, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log(`Exported ${name} ABI (${artifact.abi.length} entries) -> ${path.relative(root, outPath)}`);
}
