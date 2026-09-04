import { network } from "hardhat";

const SIMULATED_NETWORK_NAMES = new Set(["default", "hardhat", "localhost"]);

async function resolveEurcAddress(ethers, networkName, deployer) {
  if (process.env.EURC_TOKEN_ADDRESS) {
    return process.env.EURC_TOKEN_ADDRESS;
  }
  if (!SIMULATED_NETWORK_NAMES.has(networkName)) {
    throw new Error(
      `EURC_TOKEN_ADDRESS must be set to deploy against "${networkName}" -- ` +
        "refusing to guess a real EURC contract address on a non-simulated network.",
    );
  }
  const mock = await ethers.deployContract("MockEURC", [], deployer);
  const mockAddress = await mock.getAddress();
  await mock.mint(deployer.address, 100_000_000_000_000n); // 100M mock EURC, for local testing only
  console.log("No EURC_TOKEN_ADDRESS set -- deployed MockEURC for local testing:", mockAddress);
  return mockAddress;
}

async function main() {
  const uri = process.env.VISTABLOX_BASE_URI || "https://vistablox.io/api/metadata/{id}.json";

  const { ethers, networkName } = await network.create();
  const [deployer] = await ethers.getSigners();

  // Resolve (and validate) the EURC address before deploying anything, so a
  // misconfigured real-network run fails before spending any gas.
  const eurcAddress = await resolveEurcAddress(ethers, networkName, deployer);

  const property = await ethers.deployContract("VistaBloxProperty", [uri], deployer);
  const propertyAddress = await property.getAddress();

  // Dev/testnet convenience: grant every operational role to the deployer
  // (AD-165's single test-wallet flow). Production should assign these to
  // distinct governed roles/multisigs rather than one address holding all five.
  const propertyRoles = [
    await property.MINTER_ROLE(),
    await property.BURNER_ROLE(),
    await property.PAUSER_ROLE(),
    await property.TRANSFER_AGENT_ROLE(),
    await property.DOCUMENT_ROLE(),
  ];
  for (const role of propertyRoles) {
    await property.grantRole(role, deployer.address);
  }

  const escrow = await ethers.deployContract("VistaBloxIpoEscrow", [eurcAddress], deployer);
  const escrowAddress = await escrow.getAddress();
  await escrow.grantRole(await escrow.CAMPAIGN_MANAGER_ROLE(), deployer.address);

  console.log("VistaBloxProperty deployed to:", propertyAddress);
  console.log("VistaBloxIpoEscrow deployed to:", escrowAddress, "(EURC:", eurcAddress + ")");
  console.log("Deployer granted all operational roles on both contracts:", deployer.address);

  return { propertyAddress, escrowAddress, eurcAddress };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
