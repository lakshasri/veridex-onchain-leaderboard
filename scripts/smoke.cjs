const hre = require("hardhat");
const { MAX_SCORE_PER_CRITERION, WEIGHT_PS_BPS, WEIGHT_CQ_BPS, WEIGHT_EF_BPS } = require("./contest-config.cjs");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const localChainIds = [31337n, 1337n, 5777n];
  if (!localChainIds.includes(network.chainId)) {
    throw new Error(`smoke test blocked: expected local chain, got chainId ${network.chainId}`);
  }

  const [organizer, judgeA, judgeB, p1, p2, p3, outsider] = await hre.ethers.getSigners();

  const Factory = await hre.ethers.getContractFactory("ContestJudging", organizer);
  const c = await Factory.deploy(MAX_SCORE_PER_CRITERION, WEIGHT_PS_BPS, WEIGHT_CQ_BPS, WEIGHT_EF_BPS);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("deployed:", addr);

  await (await c.registerParticipant(p1.address)).wait();
  await (await c.registerParticipant(p2.address)).wait();
  await (await c.registerParticipant(p3.address)).wait();
  await (await c.registerJudge(judgeA.address)).wait();
  await (await c.registerJudge(judgeB.address)).wait();
  console.log("registered 3 participants, 2 judges");

  await (await c.setAssignment(judgeA.address, p1.address, true)).wait();
  await (await c.setAssignment(judgeA.address, p2.address, true)).wait();
  await (await c.setAssignment(judgeB.address, p2.address, true)).wait();
  await (await c.setAssignment(judgeB.address, p3.address, true)).wait();
  console.log("wired 4 assignments");

  await (await c.connect(judgeA).submitScore(p1.address, 8, 7, 9)).wait();
  await (await c.connect(judgeA).submitScore(p2.address, 6, 6, 6)).wait();
  await (await c.connect(judgeB).submitScore(p2.address, 10, 10, 10)).wait();
  await (await c.connect(judgeB).submitScore(p3.address, 5, 5, 5)).wait();
  console.log("submitted 4 scores");

  const [completed, total] = await c.globalEvaluationProgress();
  console.log(`global progress: ${completed}/${total}`);

  const [addrs, aggs, evals] = await c.leaderboardData(0, 500);
  for (let i = 0; i < addrs.length; i++) {
    const pct = (aggs[i] * 10000n) / 10n ** 18n;
    console.log(
      `  ${addrs[i].slice(0, 10)}…  agg=${pct / 100n}.${(pct % 100n).toString().padStart(2, "0")}/100  evals=${evals[i]}`
    );
  }

  if (!(await c.canFinalize())) throw new Error("canFinalize should be true");

  let threw = false;
  try {
    await c.connect(judgeA).submitScore(p1.address, 1, 1, 1);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("duplicate submit should revert");
  console.log("revert check: duplicate submit ✓");

  threw = false;
  try {
    await c.connect(judgeA).submitScore(p3.address, 1, 1, 1);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("unassigned scoring should revert");
  console.log("revert check: unassigned ✓");

  threw = false;
  try {
    await c.connect(outsider).finalize();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("non-organizer finalize should revert");
  console.log("revert check: non-organizer finalize ✓");

  await (await c.finalize()).wait();
  if (!(await c.finalized())) throw new Error("finalized flag should be true");
  console.log("finalized");

  threw = false;
  try {
    await c.registerParticipant(outsider.address);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("post-finalize mutation should revert");
  console.log("revert check: post-finalize mutation ✓");

  console.log("\nsmoke test passed. contract:", addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
