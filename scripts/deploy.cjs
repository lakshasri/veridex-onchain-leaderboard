const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const max = 10;
  const wPs = 4000n;
  const wCq = 3500n;
  const wEf = 2500n;
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
