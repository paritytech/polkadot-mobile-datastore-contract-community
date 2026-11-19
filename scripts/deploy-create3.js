// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Puts AccountDataStore on a testnet through the network's CREATE3 factory, or confirms it is there.
// The address depends only on that factory and the salt, so a chain wipe doesn't change it. Run by
// .github/workflows/deploy.yml, which paritytech/autodeployer dispatches after a wipe, or by hand.
//
//   npm run build                                       # EVM (solc) artifact; the factory rejects PolkaVM code
//   DRY_RUN=1 NETWORK=preview npm run deploy:create3    # predicted address and estimate, submits nothing
//   NETWORK=paseo-next-v2 npm run deploy:create3
//
// Env:
//   NETWORK            paseo-next-v2 | preview | polkadot-test (required)
//   DEPLOYER_MNEMONIC  sr25519 deployer passphrase (see scripts/lib/deployer-key.js); any funded
//                      account works, the address does not depend on it
//   SUBSTRATE_WS_URL   overrides the network's endpoint
//   DRY_RUN=1          everything except submitting transactions
//   MARGIN_PERCENT     headroom added to the dry-run weight and deposit, default 20
require("dotenv").config({ quiet: true });
const { Keyring } = require("@polkadot/api");
const { cryptoWaitReady, keccakAsHex } = require("@polkadot/util-crypto");
const { create3Network } = require("./lib/create3-networks");
const { create3Salt, deployCreate3, predictCreate3 } = require("./lib/create3");
const { deployerSuri } = require("./lib/deployer-key");
const { connectRevive, signAndWait } = require("./lib/revive-api");
const { loadBytecode, runCli, writeDeployment } = require("./lib/revive-deploy");

const CONTRACT_NAME = "AccountDataStore";

/**
 * Part of the CREATE3 salt, so part of the address. Bump it only when the contract changes in a way
 * that must land on a fresh address; until then a rerun adopts the existing deployment.
 */
const CONTRACT_VERSION = "1.0.0";

/** @returns {Promise<import("@polkadot/keyring/types").KeyringPair>} */
async function loadDeployer() {
  const suri = await deployerSuri();
  await cryptoWaitReady();
  return new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(suri);
}

/**
 * @param {import("@polkadot/api").ApiPromise} api
 * @returns {Promise<{ chain: string, genesisHash: string, specName: string, specVersion: number }>}
 */
async function readChainInfo(api) {
  const chain = (await api.rpc.system.chain()).toString();
  const { specName, specVersion } = api.runtimeVersion;
  return { chain, genesisHash: api.genesisHash.toHex(), specName: specName.toString(), specVersion: specVersion.toNumber() };
}

/**
 * Submits Revive.map_account when the runtime does not map on first use and the deployer is unmapped.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {import("@polkadot/keyring/types").KeyringPair} deployer
 * @param {string} h160
 * @param {boolean} dryRun
 * @returns {Promise<void>}
 */
async function mapAccountIfNeeded(api, deployer, h160, dryRun) {
  const autoMap = api.consts.revive.autoMap ? api.consts.revive.autoMap.isTrue : false;
  const mapped = (await api.query.revive.originalAccount(h160)).isSome;
  if (autoMap || mapped) return;
  if (dryRun) throw new Error(`Deployer ${h160} is unmapped and the runtime has no AutoMap; this runtime cannot dry-run an unmapped origin, run without DRY_RUN to map it first`);
  await signAndWait(api, api.tx.revive.mapAccount(), deployer);
  console.log(`  Revive.map_account submitted for ${deployer.address}`);
}

/**
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {import("@polkadot/keyring/types").KeyringPair} deployer
 * @returns {Promise<string>} the deployer's H160
 */
async function describeDeployer(api, deployer) {
  const h160 = (await api.call.reviveApi.address(deployer.address)).toString();
  const { data } = await api.query.system.account(deployer.address);
  console.log(`deployer ss58=${deployer.address} h160=${h160} free=${data.free.toBigInt()}`);
  return h160;
}

/**
 * @param {import("./lib/create3").Create3Result} result
 * @returns {void}
 */
function logResult({ address, status, estimate }) {
  if (estimate) {
    const { refTime, proofSize } = estimate.weightRequired;
    console.log(`  estimate: refTime=${refTime} proofSize=${proofSize} storageDeposit=${estimate.storageDeposit}`);
  }
  const notes = { adopted: "already deployed", "dry-run": "DRY_RUN=1, nothing submitted", deployed: "deployed" };
  console.log(`${CONTRACT_NAME} ${CONTRACT_VERSION} at ${address} (${notes[status]})`);
}

/** @typedef {{ networkName: string, network: import("./lib/create3-networks").Create3Network, dryRun: boolean, marginPercent: bigint }} DeployConfig */

/** @returns {DeployConfig} */
function readDeployConfig() {
  const networkName = process.env.NETWORK || "";
  const network = create3Network(networkName);
  const marginPercent = BigInt(process.env.MARGIN_PERCENT || "20");
  return { networkName, network, dryRun: process.env.DRY_RUN === "1", marginPercent };
}

/**
 * The deployments/<network>.json record. Written for adopted and dry-run results too: the address is
 * salt-derived, so it is meaningful before anything is submitted.
 * @param {{ config: DeployConfig, chainInfo: Awaited<ReturnType<typeof readChainInfo>>, deployer: { ss58: string, h160: string },
 *   salt: { salt: string, preimage: string }, initCode: string, result: import("./lib/create3").Create3Result }} parts
 * @returns {Record<string, unknown>}
 */
function deploymentRecord({ config, chainInfo, deployer, salt, initCode, result }) {
  const { address, status } = result;
  const contract = { contract: CONTRACT_NAME, version: CONTRACT_VERSION, address, status, network: config.networkName };
  const bytecodeKeccak256 = keccakAsHex(initCode);
  const create3 = { factory: config.network.factory, salt: salt.salt, saltPreimage: salt.preimage };
  return { ...contract, ...chainInfo, bytecode: "evm", bytecodeKeccak256, ...create3, deployer, recordedAt: new Date().toISOString() };
}

/**
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {DeployConfig} config
 * @param {import("@polkadot/keyring/types").KeyringPair} deployer
 * @param {string} initCode
 * @returns {Promise<void>}
 */
async function deployOnChain(api, config, deployer, initCode) {
  const chainInfo = await readChainInfo(api);
  const salt = create3Salt(CONTRACT_NAME, CONTRACT_VERSION);
  console.log(`network=${config.networkName} chain=${chainInfo.chain} genesis=${chainInfo.genesisHash} spec=${chainInfo.specName}/${chainInfo.specVersion}`);
  console.log(`factory=${config.network.factory} salt=${salt.salt} (${salt.preimage})${config.dryRun ? " DRY_RUN" : ""}`);
  console.log(`predicted ${CONTRACT_NAME} address=${predictCreate3(salt.salt, config.network.factory)}`);
  const h160 = await describeDeployer(api, deployer);
  await mapAccountIfNeeded(api, deployer, h160, config.dryRun);
  const { factory } = config.network;
  const { dryRun, marginPercent } = config;
  const result = await deployCreate3({ api, signer: deployer, factory, salt: salt.salt, initCode, dryRun, marginPercent });
  logResult(result);
  const record = deploymentRecord({ config, chainInfo, deployer: { ss58: deployer.address, h160 }, salt, initCode, result });
  console.log(`  written to ${writeDeployment(config.networkName, record)}`);
}

async function main() {
  const config = readDeployConfig();
  const deployer = await loadDeployer();
  const initCode = loadBytecode("evm");
  const api = await connectRevive(process.env.SUBSTRATE_WS_URL || config.network.wsUrl);
  try {
    await deployOnChain(api, config, deployer, initCode);
  } finally {
    await api.disconnect();
  }
}

runCli(main);
