const { expect } = require("chai");
const hre = require("hardhat");

describe("ContestJudging: deep feature + stress coverage", function () {
  const MAX = 10;
  const W_PS = 4000n;
  const W_CQ = 3500n;
  const W_EF = 2500n;

  async function deployFixture() {
    const [organizer, ...rest] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("ContestJudging", organizer);
    const c = await Factory.deploy(MAX, W_PS, W_CQ, W_EF);
    await c.waitForDeployment();
    return { c, organizer, signers: rest };
  }

  async function registerAll(c, judges, participants) {
    for (const p of participants) {
      await c.registerParticipant(p.address);
    }
    for (const j of judges) {
      await c.registerJudge(j.address);
    }
  }

  async function assignFullMatrix(c, judges, participants) {
    for (const j of judges) {
      for (const p of participants) {
        await c.setAssignment(j.address, p.address, true);
      }
    }
  }

  function sheetValue(jIndex, pIndex, salt) {
    const raw = BigInt((jIndex + 1) * (pIndex + 2)) + salt;
    return Number(raw % 11n);
  }

  it("enforces constructor and registration safeguards", async function () {
    const [organizer, judgeA, participant] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("ContestJudging", organizer);

    await expect(Factory.deploy(0, W_PS, W_CQ, W_EF)).to.be.revertedWithCustomError(Factory, "InvalidScore");
    await expect(Factory.deploy(MAX, 5000, 3000, 1000)).to.be.revertedWithCustomError(Factory, "InvalidScore");

    const c = await Factory.deploy(MAX, W_PS, W_CQ, W_EF);
    await c.waitForDeployment();

    await expect(c.registerParticipant(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(c, "ZeroAddress");
    await c.registerParticipant(participant.address);
    await expect(c.registerParticipant(participant.address)).to.be.revertedWithCustomError(c, "InvalidScore");

    await expect(c.registerJudge(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(c, "ZeroAddress");
    await c.registerJudge(judgeA.address);
    await expect(c.registerJudge(judgeA.address)).to.be.revertedWithCustomError(c, "InvalidScore");

    await expect(c.getParticipant(7)).to.be.reverted;
    await expect(c.getJudge(7)).to.be.reverted;
  });

  it("keeps assignment/progress counters correct when assignment edges change", async function () {
    const { c, signers } = await deployFixture();
    const [judgeA, judgeB, p1, p2] = signers;

    await registerAll(c, [judgeA, judgeB], [p1, p2]);

    await c.setAssignment(judgeA.address, p1.address, true);
    await c.setAssignment(judgeA.address, p2.address, true);
    await c.setAssignment(judgeB.address, p1.address, true);

    let [done, total] = await c.globalEvaluationProgress();
    expect(done).to.equal(0n);
    expect(total).to.equal(3n);

    await c.connect(judgeA).submitScore(p1.address, 8, 7, 9);
    [done, total] = await c.globalEvaluationProgress();
    expect(done).to.equal(1n);
    expect(total).to.equal(3n);

    let [judgeDone, judgeTotal] = await c.judgeEvaluationProgress(judgeA.address);
    expect(judgeDone).to.equal(1n);
    expect(judgeTotal).to.equal(2n);

    await c.setAssignment(judgeA.address, p1.address, false);
    [done, total] = await c.globalEvaluationProgress();
    expect(done).to.equal(0n);
    expect(total).to.equal(2n);

    [judgeDone, judgeTotal] = await c.judgeEvaluationProgress(judgeA.address);
    expect(judgeDone).to.equal(0n);
    expect(judgeTotal).to.equal(1n);

    await c.setAssignment(judgeA.address, p1.address, true);
    [done, total] = await c.globalEvaluationProgress();
    expect(done).to.equal(1n);
    expect(total).to.equal(3n);

    [judgeDone, judgeTotal] = await c.judgeEvaluationProgress(judgeA.address);
    expect(judgeDone).to.equal(1n);
    expect(judgeTotal).to.equal(2n);

    await c.connect(judgeA).submitScore(p2.address, 5, 5, 5);
    await c.connect(judgeB).submitScore(p1.address, 9, 9, 9);
    expect(await c.canFinalize()).to.equal(true);
  });

  it("matches weighted score math exactly", async function () {
    const { c } = await deployFixture();
    const expected = ((8n * W_PS + 7n * W_CQ + 9n * W_EF) * 10n ** 18n) / (10n * 10_000n);
    expect(await c.weightedScoreScaled(8, 7, 9)).to.equal(expected);
    await expect(c.weightedScoreScaled(11, 0, 0)).to.be.revertedWithCustomError(c, "InvalidScore");
  });

  it("returns consistent participant breakdown, aggregate, and leaderboard data", async function () {
    const { c, signers } = await deployFixture();
    const [judgeA, judgeB, p1, p2] = signers;

    await registerAll(c, [judgeA, judgeB], [p1, p2]);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.setAssignment(judgeA.address, p2.address, true);
    await c.setAssignment(judgeB.address, p1.address, true);

    await c.connect(judgeA).submitScore(p1.address, 10, 9, 8);
    await c.connect(judgeA).submitScore(p2.address, 5, 5, 5);
    await c.connect(judgeB).submitScore(p1.address, 8, 8, 8);

    const breakdown = await c.participantBreakdown(p1.address);
    expect(breakdown[0]).to.deep.equal([judgeA.address, judgeB.address]);
    expect(breakdown[1]).to.deep.equal([true, true]);
    expect(breakdown[2]).to.deep.equal([10n, 8n]);
    expect(breakdown[3]).to.deep.equal([9n, 8n]);
    expect(breakdown[4]).to.deep.equal([8n, 8n]);

    const wA = await c.weightedScoreScaled(10, 9, 8);
    const wB = await c.weightedScoreScaled(8, 8, 8);
    const [aggP1, evalP1, sumPs, sumCq, sumEf] = await c.participantAggregate(p1.address);
    expect(evalP1).to.equal(2n);
    expect(sumPs).to.equal(18n);
    expect(sumCq).to.equal(17n);
    expect(sumEf).to.equal(16n);
    expect(aggP1).to.equal((wA + wB) / 2n);

    const [aggP2, evalP2] = await c.participantAggregate(p2.address);
    const wP2 = await c.weightedScoreScaled(5, 5, 5);
    expect(evalP2).to.equal(1n);
    expect(aggP2).to.equal(wP2);

    const [participantsOut, aggsOut, evalCountsOut] = await c.leaderboardData();
    expect(participantsOut).to.deep.equal([p1.address, p2.address]);
    expect(aggsOut).to.deep.equal([aggP1, aggP2]);
    expect(evalCountsOut).to.deep.equal([2n, 1n]);
  });

  it("handles a large full-assignment matrix and finalizes after all submissions", async function () {
    this.timeout(120000);
    const { c, signers } = await deployFixture();
    const judges = signers.slice(0, 6);
    const participants = signers.slice(6, 16);

    await registerAll(c, judges, participants);
    await assignFullMatrix(c, judges, participants);

    const expectedSlots = BigInt(judges.length * participants.length);
    let [doneBefore, totalBefore] = await c.globalEvaluationProgress();
    expect(doneBefore).to.equal(0n);
    expect(totalBefore).to.equal(expectedSlots);

    for (let j = 0; j < judges.length; j++) {
      const jc = c.connect(judges[j]);
      for (let p = 0; p < participants.length; p++) {
        const ps = sheetValue(j, p, 1n);
        const cq = sheetValue(j, p, 2n);
        const ef = sheetValue(j, p, 3n);
        await jc.submitScore(participants[p].address, ps, cq, ef);
      }
    }

    const [doneAfter, totalAfter] = await c.globalEvaluationProgress();
    expect(doneAfter).to.equal(expectedSlots);
    expect(totalAfter).to.equal(expectedSlots);
    expect(await c.canFinalize()).to.equal(true);

    for (const judge of judges) {
      const [judgeDone, judgeTotal] = await c.judgeEvaluationProgress(judge.address);
      expect(judgeDone).to.equal(BigInt(participants.length));
      expect(judgeTotal).to.equal(BigInt(participants.length));
    }

    const [agg, evalCount] = await c.participantAggregate(participants[0].address);
    expect(agg).to.be.gt(0n);
    expect(evalCount).to.equal(BigInt(judges.length));

    const breakdown = await c.participantBreakdown(participants[0].address);
    expect(breakdown[0].length).to.equal(judges.length);
    expect(breakdown[1].every(Boolean)).to.equal(true);

    await c.finalize();
    expect(await c.finalized()).to.equal(true);
  });

  it("keeps finalize gas nearly constant as contest size grows", async function () {
    this.timeout(120000);
    const { c: small, signers: smallSigners } = await deployFixture();
    const [smallJudge, smallParticipant] = smallSigners;
    await registerAll(small, [smallJudge], [smallParticipant]);
    await small.setAssignment(smallJudge.address, smallParticipant.address, true);
    await small.connect(smallJudge).submitScore(smallParticipant.address, 10, 10, 10);
    const smallFinalizeGas = await small.getFunction("finalize").estimateGas();

    const { c: large, signers: largeSigners } = await deployFixture();
    const judges = largeSigners.slice(0, 5);
    const participants = largeSigners.slice(5, 13);
    await registerAll(large, judges, participants);
    await assignFullMatrix(large, judges, participants);
    for (let j = 0; j < judges.length; j++) {
      const jc = large.connect(judges[j]);
      for (let p = 0; p < participants.length; p++) {
        await jc.submitScore(participants[p].address, sheetValue(j, p, 4n), sheetValue(j, p, 5n), sheetValue(j, p, 6n));
      }
    }
    const largeFinalizeGas = await large.getFunction("finalize").estimateGas();

    const gasDelta = largeFinalizeGas - smallFinalizeGas;
    expect(gasDelta).to.be.lt(25_000n);
  });

  it("returns zero progress for unregistered judges", async function () {
    const { c, signers } = await deployFixture();
    const outsider = signers[10];
    const [done, total] = await c.judgeEvaluationProgress(outsider.address);
    expect(done).to.equal(0n);
    expect(total).to.equal(0n);
  });
});
