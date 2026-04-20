/** Shared deployment parameters used by deploy.cjs and smoke.cjs */
module.exports = {
  MAX_SCORE_PER_CRITERION: 10,
  WEIGHT_PS_BPS: 4000n,  // problem solving 40%
  WEIGHT_CQ_BPS: 3500n,  // code quality   35%
  WEIGHT_EF_BPS: 2500n,  // efficiency     25%
};
