const { expect } = require("chai");
const hre = require("hardhat");

/** Default Hardhat / Ganache-style 6-wallet layout: 0 organizer, 1–2 judges, 3–5 participants */
describe("ContestJudging", function () {
  const MAX = 10;
  const W_PS = 4000n;
  const W_CQ = 3500n;
  const W_EF = 2500n;

  async function deployFixture() {
    const [organizer, judgeA, judgeB, p1, p2, p3, outsider] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("ContestJudging", organizer);
    const c = await Factory.deploy(MAX, W_PS, W_CQ, W_EF);
    await c.waitForDeployment();
    return { c, organizer, judgeA, judgeB, p1, p2, p3, outsider };
  }

  it("registers participants and judges; assigns and accepts valid scores; finalizes when complete", async function () {
    const { c, organizer, judgeA, judgeB, p1, p2, p3 } = await deployFixture();

    await c.registerParticipant(p1.address);
    await c.registerParticipant(p2.address);
    await c.registerParticipant(p3.address);
    await c.registerJudge(judgeA.address);
    await c.registerJudge(judgeB.address);

    // Judge A: p1, p2 | Judge B: p2, p3
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.setAssignment(judgeA.address, p2.address, true);
    await c.setAssignment(judgeB.address, p2.address, true);
    await c.setAssignment(judgeB.address, p3.address, true);

    await c.connect(judgeA).submitScore(p1.address, 8, 7, 9);
    await c.connect(judgeA).submitScore(p2.address, 6, 6, 6);
    await c.connect(judgeB).submitScore(p2.address, 10, 10, 10);
    await c.connect(judgeB).submitScore(p3.address, 5, 5, 5);

    expect(await c.canFinalize()).to.equal(true);
    const finTx = await c.finalize();
    const finRc = await finTx.wait();
    const finBlock = await hre.ethers.provider.getBlock(finRc.blockNumber);
    await expect(finTx).to.emit(c, "Finalized").withArgs(organizer.address, finBlock.timestamp);

    expect(await c.finalized()).to.equal(true);
  });

  it("rejects non-organizer registration", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await expect(c.connect(judgeA).registerParticipant(p1.address)).to.be.revertedWithCustomError(c, "NotOrganizer");
  });

  it("rejects judge scoring a participant not assigned to them", async function () {
    const { c, judgeA, p1, p2 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerParticipant(p2.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await expect(c.connect(judgeA).submitScore(p2.address, 5, 5, 5)).to.be.revertedWithCustomError(c, "NotAssigned");
  });

  it("rejects duplicate submission for same judge–participant pair", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await expect(c.connect(judgeA).submitScore(p1.address, 9, 9, 9)).to.be.revertedWithCustomError(c, "AlreadySubmitted");
  });

  it("rejects scores above max per criterion", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await expect(c.connect(judgeA).submitScore(p1.address, 11, 0, 0)).to.be.revertedWithCustomError(c, "InvalidScore");
  });

  it("rejects non-judge submitting scores", async function () {
    const { c, outsider, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await expect(c.connect(outsider).submitScore(p1.address, 5, 5, 5)).to.be.revertedWithCustomError(c, "NotJudge");
  });

  it("rejects scoring an address that is not a registered participant", async function () {
    const { c, judgeA, p1, outsider } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await expect(c.connect(judgeA).submitScore(outsider.address, 5, 5, 5)).to.be.revertedWithCustomError(
      c,
      "NotParticipant"
    );
  });

  it("rejects finalize before all assigned evaluations are submitted", async function () {
    const { c, judgeA, judgeB, p1, p2 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerParticipant(p2.address);
    await c.registerJudge(judgeA.address);
    await c.registerJudge(judgeB.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.setAssignment(judgeB.address, p2.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await expect(c.finalize()).to.be.revertedWithCustomError(c, "FinalizationIncomplete");
  });

  it("rejects any score change after finalization", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await c.finalize();
    await expect(c.connect(judgeA).submitScore(p1.address, 10, 10, 10)).to.be.revertedWithCustomError(c, "AlreadyFinalized");
  });

  it("rejects organizer mutating registrations after finalization", async function () {
    const { c, judgeA, p1, p2 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await c.finalize();
    await expect(c.registerParticipant(p2.address)).to.be.revertedWithCustomError(c, "AlreadyFinalized");
  });

  it("rejects non-organizer finalize", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await expect(c.connect(judgeA).finalize()).to.be.revertedWithCustomError(c, "NotOrganizer");
  });

  it("rejects invalid assignment when judge or participant not registered", async function () {
    const { c, judgeA, p1, outsider } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await expect(c.setAssignment(outsider.address, p1.address, true)).to.be.revertedWithCustomError(
      c,
      "JudgeOrParticipantNotRegistered"
    );
  });

  it("computes weighted aggregate as average across judges who scored", async function () {
    const { c, judgeA, judgeB, p2 } = await deployFixture();
    await c.registerParticipant(p2.address);
    await c.registerJudge(judgeA.address);
    await c.registerJudge(judgeB.address);
    await c.setAssignment(judgeA.address, p2.address, true);
    await c.setAssignment(judgeB.address, p2.address, true);
    // both all 10 → weighted sheet = 1e18
    await c.connect(judgeA).submitScore(p2.address, 10, 10, 10);
    await c.connect(judgeB).submitScore(p2.address, 10, 10, 10);
    const [agg, count] = await c.participantAggregate(p2.address);
    expect(count).to.equal(2n);
    expect(agg).to.equal(10n ** 18n);
  });

  it("lets organizer correct a submitted score and updates aggregates", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 10, 10, 10);
    await expect(c.correctScore(judgeA.address, p1.address, 5, 5, 5))
      .to.emit(c, "OrganizerScoreCorrected")
      .withArgs(judgeA.address, p1.address, 5, 5, 5, await c.weightedScoreScaled(5, 5, 5));
    const [agg, count] = await c.participantAggregate(p1.address);
    expect(count).to.equal(1n);
    expect(agg).to.equal(await c.weightedScoreScaled(5, 5, 5));
  });

  it("rejects organizer correct when nothing submitted yet", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await expect(c.correctScore(judgeA.address, p1.address, 5, 5, 5)).to.be.revertedWithCustomError(c, "NoSubmissionToCorrect");
  });

  it("rejects non-organizer correctScore", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await expect(c.connect(judgeA).correctScore(judgeA.address, p1.address, 9, 9, 9)).to.be.revertedWithCustomError(
      c,
      "NotOrganizer"
    );
  });

  it("rejects correctScore after finalize", async function () {
    const { c, judgeA, p1 } = await deployFixture();
    await c.registerParticipant(p1.address);
    await c.registerJudge(judgeA.address);
    await c.setAssignment(judgeA.address, p1.address, true);
    await c.connect(judgeA).submitScore(p1.address, 5, 5, 5);
    await c.finalize();
    await expect(c.correctScore(judgeA.address, p1.address, 9, 9, 9)).to.be.revertedWithCustomError(c, "AlreadyFinalized");
  });
});
