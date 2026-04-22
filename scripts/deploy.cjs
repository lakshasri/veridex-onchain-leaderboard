const hre = require("hardhat");
const { MAX_SCORE_PER_CRITERION, WEIGHT_PS_BPS, WEIGHT_CQ_BPS, WEIGHT_EF_BPS } = require("./contest-config.cjs");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const max = MAX_SCORE_PER_CRITERION;
  const wPs = WEIGHT_PS_BPS;
  const wCq = WEIGHT_CQ_BPS;
  const wEf = WEIGHT_EF_BPS;
  const Factory = await hre.ethers.getContractFactory("ContestJudging", deployer);
  const c = await Factory.deploy(max, wPs, wCq, wEf);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  if (!addr || addr === hre.ethers.ZeroAddress) throw new Error("deployment failed: zero address returned");
  const onChainOrganizer = await c.organizer();
  if (onChainOrganizer.toLowerCase() !== deployer.address.toLowerCase()) throw new Error("organizer mismatch after deploy");
  console.log("ContestJudging deployed to", addr);
  console.log("Organizer (deployer):", deployer.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
