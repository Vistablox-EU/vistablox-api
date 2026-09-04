import { expect } from "chai";
import { network } from "hardhat";

describe("VistaBloxProperty", function () {
  const URI = "https://vistablox.io/api/metadata/{id}.json";
  const TOKEN_ID = 1n;
  const OTHER_TOKEN_ID = 2n;
  const MINT_AMOUNT = 300_000n;

  let ethers;
  let admin;
  let minter;
  let burner;
  let pauser;
  let transferAgent;
  let documentManager;
  let holder1;
  let holder2;
  let stranger;
  let contract;
  let ROLE;

  before(async function () {
    ({ ethers } = await network.create());
    [admin, minter, burner, pauser, transferAgent, documentManager, holder1, holder2, stranger] =
      await ethers.getSigners();
  });

  beforeEach(async function () {
    contract = await ethers.deployContract("VistaBloxProperty", [URI], admin);

    ROLE = {
      minter: await contract.MINTER_ROLE(),
      burner: await contract.BURNER_ROLE(),
      pauser: await contract.PAUSER_ROLE(),
      transferAgent: await contract.TRANSFER_AGENT_ROLE(),
      document: await contract.DOCUMENT_ROLE(),
    };

    await contract.connect(admin).grantRole(ROLE.minter, minter.address);
    await contract.connect(admin).grantRole(ROLE.burner, burner.address);
    await contract.connect(admin).grantRole(ROLE.pauser, pauser.address);
    await contract.connect(admin).grantRole(ROLE.transferAgent, transferAgent.address);
    await contract.connect(admin).grantRole(ROLE.document, documentManager.address);
  });

  function reasonCode(text) {
    return ethers.encodeBytes32String(text);
  }

  describe("deployment", function () {
    it("grants only DEFAULT_ADMIN_ROLE to the deployer", async function () {
      const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
      expect(await contract.hasRole(defaultAdminRole, admin.address)).to.be.true;
      expect(await contract.hasRole(ROLE.minter, admin.address)).to.be.false;
      expect(await contract.hasRole(ROLE.burner, admin.address)).to.be.false;
      expect(await contract.hasRole(ROLE.pauser, admin.address)).to.be.false;
      expect(await contract.hasRole(ROLE.transferAgent, admin.address)).to.be.false;
      expect(await contract.hasRole(ROLE.document, admin.address)).to.be.false;
    });

    it("reports ERC1155 and AccessControl interface support", async function () {
      expect(await contract.supportsInterface("0xd9b67a26")).to.be.true; // IERC1155
      expect(await contract.supportsInterface("0x7965db0b")).to.be.true; // IAccessControl
      expect(await contract.supportsInterface("0x01ffc9a7")).to.be.true; // IERC165
    });
  });

  describe("mint", function () {
    it("reverts when the recipient is not authorized for the token id", async function () {
      await expect(contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x"))
        .to.be.revertedWithCustomError(contract, "HolderNotAuthorized")
        .withArgs(TOKEN_ID, holder1.address);
    });

    it("mints once the recipient is authorized, and tracks total supply", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");

      expect(await contract.balanceOf(holder1.address, TOKEN_ID)).to.equal(MINT_AMOUNT);
      expect(await contract["totalSupply(uint256)"](TOKEN_ID)).to.equal(MINT_AMOUNT);
    });

    it("reverts when called by an account without MINTER_ROLE", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await expect(
        contract.connect(stranger).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x"),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("burn", function () {
    beforeEach(async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");
    });

    it("reduces balance and total supply", async function () {
      await contract.connect(burner).burn(holder1.address, TOKEN_ID, 100_000n);
      expect(await contract.balanceOf(holder1.address, TOKEN_ID)).to.equal(200_000n);
      expect(await contract["totalSupply(uint256)"](TOKEN_ID)).to.equal(200_000n);
    });

    it("reverts when called by an account without BURNER_ROLE", async function () {
      await expect(
        contract.connect(stranger).burn(holder1.address, TOKEN_ID, 100_000n),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("per-token-ID pause", function () {
    beforeEach(async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await contract.connect(transferAgent).authorizeHolder(holder1.address, OTHER_TOKEN_ID);
    });

    it("blocks mint for the paused token id only", async function () {
      await contract.connect(pauser).pauseToken(TOKEN_ID);

      await expect(contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x"))
        .to.be.revertedWithCustomError(contract, "TokenIsPaused")
        .withArgs(TOKEN_ID);

      // A different token id is unaffected.
      await contract.connect(minter).mint(holder1.address, OTHER_TOKEN_ID, MINT_AMOUNT, "0x");
      expect(await contract.balanceOf(holder1.address, OTHER_TOKEN_ID)).to.equal(MINT_AMOUNT);
    });

    it("resumes after unpauseToken", async function () {
      await contract.connect(pauser).pauseToken(TOKEN_ID);
      await contract.connect(pauser).unpauseToken(TOKEN_ID);
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");
      expect(await contract.balanceOf(holder1.address, TOKEN_ID)).to.equal(MINT_AMOUNT);
    });

    it("reverts pauseToken/unpauseToken when called by an account without PAUSER_ROLE", async function () {
      await expect(
        contract.connect(stranger).pauseToken(TOKEN_ID),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
      await expect(
        contract.connect(stranger).unpauseToken(TOKEN_ID),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("contract-wide pause", function () {
    beforeEach(async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
    });

    it("blocks mint across every token id, and only DEFAULT_ADMIN_ROLE can toggle it", async function () {
      await expect(contract.connect(pauser).pause()).to.be.revertedWithCustomError(
        contract,
        "AccessControlUnauthorizedAccount",
      );

      await contract.connect(admin).pause();
      await expect(
        contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x"),
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");

      await contract.connect(admin).unpause();
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");
      expect(await contract.balanceOf(holder1.address, TOKEN_ID)).to.equal(MINT_AMOUNT);
    });
  });

  describe("authorizeHolder / deauthorizeHolder", function () {
    it("is scoped per token id and toggles isHolderAuthorized", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      expect(await contract.isHolderAuthorized(holder1.address, TOKEN_ID)).to.be.true;
      expect(await contract.isHolderAuthorized(holder1.address, OTHER_TOKEN_ID)).to.be.false;

      await contract.connect(transferAgent).deauthorizeHolder(holder1.address, TOKEN_ID);
      expect(await contract.isHolderAuthorized(holder1.address, TOKEN_ID)).to.be.false;

      await expect(
        contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x"),
      )
        .to.be.revertedWithCustomError(contract, "HolderNotAuthorized")
        .withArgs(TOKEN_ID, holder1.address);
    });

    it("reverts when called by an account without TRANSFER_AGENT_ROLE", async function () {
      await expect(
        contract.connect(stranger).authorizeHolder(holder1.address, TOKEN_ID),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
      await expect(
        contract.connect(stranger).deauthorizeHolder(holder1.address, TOKEN_ID),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("forceTransfer", function () {
    beforeEach(async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");
    });

    it("moves balance between two authorized holders and emits ForcedTransfer", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder2.address, TOKEN_ID);

      await expect(
        contract
          .connect(transferAgent)
          .forceTransfer(holder1.address, holder2.address, TOKEN_ID, MINT_AMOUNT, reasonCode("lost_device")),
      )
        .to.emit(contract, "ForcedTransfer")
        .withArgs(TOKEN_ID, holder1.address, holder2.address, MINT_AMOUNT, reasonCode("lost_device"), transferAgent.address);

      expect(await contract.balanceOf(holder1.address, TOKEN_ID)).to.equal(0n);
      expect(await contract.balanceOf(holder2.address, TOKEN_ID)).to.equal(MINT_AMOUNT);
    });

    it("reverts when the destination is not authorized for the token id", async function () {
      await expect(
        contract
          .connect(transferAgent)
          .forceTransfer(holder1.address, holder2.address, TOKEN_ID, MINT_AMOUNT, reasonCode("x")),
      )
        .to.be.revertedWithCustomError(contract, "HolderNotAuthorized")
        .withArgs(TOKEN_ID, holder2.address);
    });

    it("respects per-token pause", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder2.address, TOKEN_ID);
      await contract.connect(pauser).pauseToken(TOKEN_ID);
      await expect(
        contract
          .connect(transferAgent)
          .forceTransfer(holder1.address, holder2.address, TOKEN_ID, MINT_AMOUNT, reasonCode("x")),
      )
        .to.be.revertedWithCustomError(contract, "TokenIsPaused")
        .withArgs(TOKEN_ID);
    });

    it("reverts when called by an account without TRANSFER_AGENT_ROLE", async function () {
      await contract.connect(transferAgent).authorizeHolder(holder2.address, TOKEN_ID);
      await expect(
        contract
          .connect(stranger)
          .forceTransfer(holder1.address, holder2.address, TOKEN_ID, MINT_AMOUNT, reasonCode("x")),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("setDocumentHash", function () {
    it("stores and exposes the document hash and uri, and emits DocumentHashSet", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes("disclosure-pack-v3"));
      const uri = "ipfs://disclosure-pack-v3";

      await expect(contract.connect(documentManager).setDocumentHash(TOKEN_ID, hash, uri))
        .to.emit(contract, "DocumentHashSet")
        .withArgs(TOKEN_ID, hash, uri, documentManager.address);

      expect(await contract.documentHashOf(TOKEN_ID)).to.equal(hash);
      expect(await contract.documentUriOf(TOKEN_ID)).to.equal(uri);
    });

    it("reverts when called by an account without DOCUMENT_ROLE", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes("disclosure-pack-v3"));
      await expect(
        contract.connect(stranger).setDocumentHash(TOKEN_ID, hash, "ipfs://x"),
      ).to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount");
    });
  });

  describe("closed transfer lane", function () {
    beforeEach(async function () {
      await contract.connect(transferAgent).authorizeHolder(holder1.address, TOKEN_ID);
      await contract.connect(transferAgent).authorizeHolder(holder2.address, TOKEN_ID);
      await contract.connect(minter).mint(holder1.address, TOKEN_ID, MINT_AMOUNT, "0x");
    });

    it("rejects safeTransferFrom even between two authorized holders", async function () {
      await expect(
        contract
          .connect(holder1)
          .safeTransferFrom(holder1.address, holder2.address, TOKEN_ID, MINT_AMOUNT, "0x"),
      ).to.be.revertedWithCustomError(contract, "TransferLaneClosed");
    });

    it("rejects safeBatchTransferFrom", async function () {
      await expect(
        contract
          .connect(holder1)
          .safeBatchTransferFrom(holder1.address, holder2.address, [TOKEN_ID], [MINT_AMOUNT], "0x"),
      ).to.be.revertedWithCustomError(contract, "TransferLaneClosed");
    });
  });
});
