// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title On-Chain Contest Judging & Leaderboard
/// @notice Transparent judging: assignments enforced, immutable submissions, organizer finalization locks state.
contract ContestJudging {
    address public organizer;
    address public pendingOrganizer;
    bool public finalized;

    /// @dev Maximum raw points per criterion (inclusive).
    uint8 public immutable maxPerCriterion;

    /// @dev Weights in basis points (sum should equal 10000 for a 0–100 normalized aggregate).
    uint256 public immutable weightProblemSolvingBps;
    uint256 public immutable weightCodeQualityBps;
    uint256 public immutable weightEfficiencyBps;

    address[] private _participants;
    address[] private _judges;

    mapping(address => bool) public isParticipant;
    mapping(address => bool) public isJudge;
    /// @notice judge => participant => assigned to evaluate
    mapping(address => mapping(address => bool)) public isAssigned;

    struct ScoreSubmission {
        bool submitted;
        uint8 problemSolving;
        uint8 codeQuality;
        uint8 efficiency;
    }

    struct ParticipantTotals {
        uint256 totalWeightedScaled;
        uint256 evalCount;
        uint256 sumPs;
        uint256 sumCq;
        uint256 sumEf;
    }

    /// @notice judge => participant => score (immutable after first submit)
    mapping(address => mapping(address => ScoreSubmission)) public scores;
    mapping(address => ParticipantTotals) private _participantTotals;

    uint256 private _totalAssignedSlots;
    uint256 private _completedAssignedSlots;
    mapping(address => uint256) private _judgeAssignedSlots;
    mapping(address => uint256) private _judgeCompletedSlots;

    event OrganizerTransferProposed(address indexed proposed);
    event OrganizerTransferred(address indexed previous, address indexed next);
    event ParticipantRegistered(address indexed participant);
    event JudgeRegistered(address indexed judge);
    event AssignmentUpdated(address indexed judge, address indexed participant, bool allowed);
    event ScoreSubmitted(
        address indexed judge,
        address indexed participant,
        uint8 problemSolving,
        uint8 codeQuality,
        uint8 efficiency,
        uint256 weightedScoreScaled
    );
    event Finalized(address indexed organizer, uint256 timestamp);

    error NotOrganizer();
    error NotPendingOrganizer();
    error AlreadyFinalized();
    error NotParticipant();
    error NotJudge();
    error NotAssigned();
    error AlreadySubmitted();
    error InvalidScore();
    error JudgeOrParticipantNotRegistered();
    error FinalizationIncomplete();
    error ZeroAddress();

    modifier onlyOrganizer() {
        if (msg.sender != organizer) revert NotOrganizer();
        _;
    }

    modifier whenNotFinalized() {
        if (finalized) revert AlreadyFinalized();
        _;
    }

    /// @param maxScorePerCriterion e.g. 10 → each criterion is 0..10
    /// @param wPsBps weight for problem solving in basis points (e.g. 4000 = 40%)
    /// @param wCqBps weight for code quality
    /// @param wEfBps weight for efficiency (should sum to 10000 with the others)
    constructor(uint8 maxScorePerCriterion, uint256 wPsBps, uint256 wCqBps, uint256 wEfBps) {
        organizer = msg.sender;
        if (maxScorePerCriterion == 0) revert InvalidScore();
        maxPerCriterion = maxScorePerCriterion;
        weightProblemSolvingBps = wPsBps;
        weightCodeQualityBps = wCqBps;
        weightEfficiencyBps = wEfBps;
        if (wPsBps + wCqBps + wEfBps != 10_000) revert InvalidScore();
    }

    function proposeOrganizer(address newOrganizer) external onlyOrganizer {
        if (newOrganizer == address(0)) revert ZeroAddress();
        pendingOrganizer = newOrganizer;
        emit OrganizerTransferProposed(newOrganizer);
    }

    function acceptOrganizer() external {
        if (msg.sender != pendingOrganizer) revert NotPendingOrganizer();
        emit OrganizerTransferred(organizer, msg.sender);
        organizer = msg.sender;
        pendingOrganizer = address(0);
    }

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function judgeCount() external view returns (uint256) {
        return _judges.length;
    }

    function getParticipant(uint256 index) external view returns (address) {
        return _participants[index];
    }

    function getJudge(uint256 index) external view returns (address) {
        return _judges[index];
    }

    function registerParticipant(address participant) external onlyOrganizer whenNotFinalized {
        if (participant == address(0)) revert ZeroAddress();
        if (isParticipant[participant]) revert InvalidScore();
        isParticipant[participant] = true;
        _participants.push(participant);
        emit ParticipantRegistered(participant);
    }

    function registerJudge(address judgeAddr) external onlyOrganizer whenNotFinalized {
        if (judgeAddr == address(0)) revert ZeroAddress();
        if (isJudge[judgeAddr]) revert InvalidScore();
        isJudge[judgeAddr] = true;
        _judges.push(judgeAddr);
        emit JudgeRegistered(judgeAddr);
    }

    function setAssignment(address judgeAddr, address participant, bool allowed) external onlyOrganizer whenNotFinalized {
        if (!isJudge[judgeAddr] || !isParticipant[participant]) revert JudgeOrParticipantNotRegistered();
        bool prev = isAssigned[judgeAddr][participant];
        if (prev != allowed) {
            if (!allowed && scores[judgeAddr][participant].submitted) revert AlreadySubmitted();
            if (allowed) {
                _totalAssignedSlots++;
                _judgeAssignedSlots[judgeAddr]++;
            } else {
                _totalAssignedSlots--;
                _judgeAssignedSlots[judgeAddr]--;
            }
        }
        isAssigned[judgeAddr][participant] = allowed;
        emit AssignmentUpdated(judgeAddr, participant, allowed);
    }

    /// @notice Weighted aggregate for one judge's sheet, scaled to 1e18 (float-free).
    /// @dev Max scaled score ≈ 1e18 when all criteria are maxPerCriterion.
    function weightedScoreScaled(uint8 ps, uint8 cq, uint8 ef) public view returns (uint256) {
        if (ps > maxPerCriterion || cq > maxPerCriterion || ef > maxPerCriterion) revert InvalidScore();
        uint256 maxU = uint256(maxPerCriterion);
        uint256 num = uint256(ps) * weightProblemSolvingBps + uint256(cq) * weightCodeQualityBps + uint256(ef) * weightEfficiencyBps;
        return (num * 1e18) / (maxU * 10_000);
    }

    function submitScore(address participant, uint8 problemSolving, uint8 codeQuality, uint8 efficiency)
        external
        whenNotFinalized
    {
        if (!isJudge[msg.sender]) revert NotJudge();
        if (!isParticipant[participant]) revert NotParticipant();
        if (!isAssigned[msg.sender][participant]) revert NotAssigned();
        if (scores[msg.sender][participant].submitted) revert AlreadySubmitted();
        if (problemSolving > maxPerCriterion || codeQuality > maxPerCriterion || efficiency > maxPerCriterion) {
            revert InvalidScore();
        }

        scores[msg.sender][participant] = ScoreSubmission({
            submitted: true,
            problemSolving: problemSolving,
            codeQuality: codeQuality,
            efficiency: efficiency
        });

        uint256 w = weightedScoreScaled(problemSolving, codeQuality, efficiency);
        _completedAssignedSlots++;
        _judgeCompletedSlots[msg.sender]++;

        ParticipantTotals storage totals = _participantTotals[participant];
        totals.totalWeightedScaled += w;
        totals.evalCount++;
        totals.sumPs += problemSolving;
        totals.sumCq += codeQuality;
        totals.sumEf += efficiency;

        emit ScoreSubmitted(msg.sender, participant, problemSolving, codeQuality, efficiency, w);
    }

    /// @notice True when every registered judge has submitted for every participant they are assigned.
    function canFinalize() public view returns (bool) {
        return _completedAssignedSlots == _totalAssignedSlots;
    }

    function finalize() external onlyOrganizer whenNotFinalized {
        if (!canFinalize()) revert FinalizationIncomplete();
        finalized = true;
        emit Finalized(msg.sender, block.timestamp);
    }

    /// @notice Submissions completed / total assignment slots (judge × participant pairs with assignment true).
    function globalEvaluationProgress() external view returns (uint256 completed, uint256 totalAssignedSlots) {
        completed = _completedAssignedSlots;
        totalAssignedSlots = _totalAssignedSlots;
    }

    /// @notice For one judge: how many assigned evaluations are done vs total assigned to them.
    function judgeEvaluationProgress(address judgeAddr) external view returns (uint256 completed, uint256 assignedToJudge) {
        if (!isJudge[judgeAddr]) return (0, 0);
        completed = _judgeCompletedSlots[judgeAddr];
        assignedToJudge = _judgeAssignedSlots[judgeAddr];
    }

    function _participantAggregateInternal(address participant)
        private
        view
        returns (uint256 aggregateScaled, uint256 evalCount, uint256 sumPs, uint256 sumCq, uint256 sumEf)
    {
        ParticipantTotals storage totals = _participantTotals[participant];
        evalCount = totals.evalCount;
        sumPs = totals.sumPs;
        sumCq = totals.sumCq;
        sumEf = totals.sumEf;
        aggregateScaled = evalCount == 0 ? 0 : totals.totalWeightedScaled / evalCount;
    }

    /// @return aggregateScaled Average of per-judge weighted scores (1e18 scale) across judges who submitted for `participant`.
    /// @return evalCount Number of judges who submitted for this participant.
    /// @return sumPs sum of raw problem-solving points from those judges
    /// @return sumCq sum of code quality
    /// @return sumEf sum of efficiency
    function participantAggregate(address participant)
        external
        view
        returns (uint256 aggregateScaled, uint256 evalCount, uint256 sumPs, uint256 sumCq, uint256 sumEf)
    {
        if (!isParticipant[participant]) revert NotParticipant();
        return _participantAggregateInternal(participant);
    }

    /// @notice Per-judge breakdown for a participant with pagination over the judge list.
    function participantBreakdown(address participant, uint256 offset, uint256 limit)
        external
        view
        returns (
            address[] memory judgesOut,
            bool[] memory submittedFlags,
            uint8[] memory psOut,
            uint8[] memory cqOut,
            uint8[] memory efOut,
            uint256[] memory weightedScaledOut
        )
    {
        if (!isParticipant[participant]) revert NotParticipant();
        uint256 total = _judges.length;
        if (offset >= total || limit == 0) {
            return (new address[](0), new bool[](0), new uint8[](0), new uint8[](0), new uint8[](0), new uint256[](0));
        }
        uint256 end = offset + limit > total ? total : offset + limit;
        uint256 size = end - offset;
        judgesOut = new address[](size);
        submittedFlags = new bool[](size);
        psOut = new uint8[](size);
        cqOut = new uint8[](size);
        efOut = new uint8[](size);
        weightedScaledOut = new uint256[](size);

        for (uint256 j = 0; j < size; j++) {
            address jAddr = _judges[offset + j];
            judgesOut[j] = jAddr;
            ScoreSubmission storage s = scores[jAddr][participant];
            submittedFlags[j] = s.submitted;
            if (s.submitted) {
                psOut[j] = s.problemSolving;
                cqOut[j] = s.codeQuality;
                efOut[j] = s.efficiency;
                weightedScaledOut[j] = weightedScoreScaled(s.problemSolving, s.codeQuality, s.efficiency);
            }
        }
    }

    /// @notice Leaderboard data (unsorted) with pagination. Frontend sorts by `aggregateScaled` descending.
    function leaderboardData(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory participantsOut, uint256[] memory aggregateScaledOut, uint256[] memory evalCountsOut)
    {
        uint256 total = _participants.length;
        if (offset >= total || limit == 0) {
            return (new address[](0), new uint256[](0), new uint256[](0));
        }
        uint256 end = offset + limit > total ? total : offset + limit;
        uint256 size = end - offset;
        participantsOut = new address[](size);
        aggregateScaledOut = new uint256[](size);
        evalCountsOut = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            address p = _participants[offset + i];
            participantsOut[i] = p;
            (uint256 agg, uint256 ec,,,) = _participantAggregateInternal(p);
            aggregateScaledOut[i] = agg;
            evalCountsOut[i] = ec;
        }
    }
}
