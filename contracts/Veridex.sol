// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract Veridex {

    // --- Enums ---
    enum Phase { Registration, Scoring, Finalized }

    // --- Data Structures ---
    struct Participant {
        address walletAddress;
        string name;
        uint256 totalScore;      // running sum of weighted scores from all judges
        uint256 evaluatedCount;  // how many judges have scored this participant
        bool hasBeenScored;
    }

    struct Judge {
        address walletAddress;
        string name;
        address[] assignedParticipants;
        uint256 submissionCount;
    }

    struct Score {
        uint256 problemSolving;
        uint256 codeQuality;
        uint256 efficiency;
        bool submitted;
        uint256 submittedAt; // block.timestamp when submitted
    }

    // --- State Variables ---
    address public organizer;
    Phase public phase;

    string public contestName;
    string public contestDescription;
    uint256 public immutable weightProblemSolving;
    uint256 public immutable weightCodeQuality;
    uint256 public immutable weightEfficiency;
    uint256 public contestStartTime;

    mapping(address => Participant) public participants;
    mapping(address => Judge) public judges;
    mapping(address => mapping(address => Score)) public scores; // judge => participant => Score
    mapping(address => mapping(address => bool)) public assigned; // judge => participant => bool

    address[] public participantList;
    address[] public judgeList;

    // --- Events ---
    event ParticipantRegistered(address indexed addr, string name);
    event JudgeRegistered(address indexed addr, string name);
    event ParticipantAssigned(address indexed judge, address indexed participant);
    event ScoreSubmitted(address indexed judge, address indexed participant, uint256 aggregate);
    event ContestFinalized();

    // --- Modifiers ---
    modifier onlyOrganizer() {
        require(msg.sender == organizer, "Not organizer");
        _;
    }

    modifier onlyJudge() {
        require(judges[msg.sender].walletAddress != address(0), "Not a judge");
        _;
    }

    modifier notFinalized() {
        require(phase != Phase.Finalized, "Contest is finalized");
        _;
    }

    modifier assignedJudge(address judgeAddr, address participantAddr) {
        require(assigned[judgeAddr][participantAddr], "Not assigned to this participant");
        _;
    }

    // --- Constructor ---
    constructor(
        string memory _name,
        string memory _description,
        uint256 _wPS,
        uint256 _wCQ,
        uint256 _wEff
    ) {
        require(_wPS + _wCQ + _wEff == 100, "Weights must sum to 100");
        organizer = msg.sender;
        contestName = _name;
        contestDescription = _description;
        weightProblemSolving = _wPS;
        weightCodeQuality = _wCQ;
        weightEfficiency = _wEff;
        contestStartTime = block.timestamp;
        phase = Phase.Registration;
    }

    // --- Organizer Functions ---

    function registerParticipant(address _addr, string memory _name) public onlyOrganizer notFinalized {
        require(phase == Phase.Registration, "Only during Registration phase");
        require(participants[_addr].walletAddress == address(0), "Already registered");
        participants[_addr] = Participant({
            walletAddress: _addr,
            name: _name,
            totalScore: 0,
            evaluatedCount: 0,
            hasBeenScored: false
        });
        participantList.push(_addr);
        emit ParticipantRegistered(_addr, _name);
    }

    function registerJudge(address _addr, string memory _name) public onlyOrganizer notFinalized {
        require(phase == Phase.Registration, "Only during Registration phase");
        require(judges[_addr].walletAddress == address(0), "Already registered");
        judges[_addr].walletAddress = _addr;
        judges[_addr].name = _name;
        judgeList.push(_addr);
        emit JudgeRegistered(_addr, _name);
    }

    function assignParticipantsToJudge(address _judgeAddr, address[] memory _participants) public onlyOrganizer notFinalized {
        require(judges[_judgeAddr].walletAddress != address(0), "Judge not registered");
        for (uint256 i = 0; i < _participants.length; i++) {
            address p = _participants[i];
            require(participants[p].walletAddress != address(0), "Participant not registered");
            require(!assigned[_judgeAddr][p], "Already assigned");
            assigned[_judgeAddr][p] = true;
            judges[_judgeAddr].assignedParticipants.push(p);
            emit ParticipantAssigned(_judgeAddr, p);
        }
        if (phase == Phase.Registration) {
            phase = Phase.Scoring;
        }
    }

    function finalizeResults() public onlyOrganizer notFinalized {
        require(allJudgesCompleted(), "Not all judges have submitted");
        phase = Phase.Finalized;
        emit ContestFinalized();
    }

    // --- Judge Functions ---

    function submitScore(
        address _participantAddr,
        uint256 _problemSolving,
        uint256 _codeQuality,
        uint256 _efficiency
    )
        public
        onlyJudge
        notFinalized
        assignedJudge(msg.sender, _participantAddr)
    {
        require(!scores[msg.sender][_participantAddr].submitted, "Score already submitted");
        require(_problemSolving <= 100, "Score out of range");
        require(_codeQuality <= 100, "Score out of range");
        require(_efficiency <= 100, "Score out of range");

        uint256 weighted = calculateWeightedScore(_problemSolving, _codeQuality, _efficiency);

        scores[msg.sender][_participantAddr] = Score({
            problemSolving: _problemSolving,
            codeQuality: _codeQuality,
            efficiency: _efficiency,
            submitted: true,
            submittedAt: block.timestamp
        });

        judges[msg.sender].submissionCount++;
        participants[_participantAddr].totalScore += weighted;
        participants[_participantAddr].evaluatedCount++;
        participants[_participantAddr].hasBeenScored = true;

        emit ScoreSubmitted(msg.sender, _participantAddr, weighted);
    }

    // --- Internal Logic ---

    function calculateWeightedScore(uint256 _p, uint256 _c, uint256 _e) internal view returns (uint256) {
        return (_p * weightProblemSolving + _c * weightCodeQuality + _e * weightEfficiency) / 100;
    }

    function getProblemSolvingSum(address _participant) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < judgeList.length; i++) {
            if (scores[judgeList[i]][_participant].submitted) {
                sum += scores[judgeList[i]][_participant].problemSolving;
            }
        }
        return sum;
    }

    // --- View / Read Functions ---

    function getLeaderboard() public view returns (address[] memory) {
        uint256 n = participantList.length;
        address[] memory sorted = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            sorted[i] = participantList[i];
        }
        // Bubble sort descending — tie-break by problem solving sum
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = 0; j < n - i - 1; j++) {
                bool shouldSwap = false;
                uint256 scoreA = participants[sorted[j]].totalScore;
                uint256 scoreB = participants[sorted[j + 1]].totalScore;
                if (scoreA < scoreB) {
                    shouldSwap = true;
                } else if (scoreA == scoreB) {
                    uint256 psA = getProblemSolvingSum(sorted[j]);
                    uint256 psB = getProblemSolvingSum(sorted[j + 1]);
                    if (psA < psB) shouldSwap = true;
                }
                if (shouldSwap) {
                    address temp = sorted[j];
                    sorted[j] = sorted[j + 1];
                    sorted[j + 1] = temp;
                }
            }
        }
        return sorted;
    }

    function getFullLeaderboard() public view returns (
        address[] memory addrs,
        string[] memory names,
        uint256[] memory totalScores,
        uint256[] memory evaluatedCounts
    ) {
        addrs = getLeaderboard();
        uint256 n = addrs.length;
        names = new string[](n);
        totalScores = new uint256[](n);
        evaluatedCounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            names[i] = participants[addrs[i]].name;
            totalScores[i] = participants[addrs[i]].totalScore;
            evaluatedCounts[i] = participants[addrs[i]].evaluatedCount;
        }
    }

    function getParticipantScore(address _addr) public view returns (uint256, uint256, uint256, uint256) {
        uint256 psSum = 0;
        uint256 cqSum = 0;
        uint256 effSum = 0;
        for (uint256 i = 0; i < judgeList.length; i++) {
            Score memory s = scores[judgeList[i]][_addr];
            if (s.submitted) {
                psSum += s.problemSolving;
                cqSum += s.codeQuality;
                effSum += s.efficiency;
            }
        }
        return (psSum, cqSum, effSum, participants[_addr].totalScore);
    }

    function getScoreByJudge(address _judge, address _participant) public view returns (
        uint256 problemSolving,
        uint256 codeQuality,
        uint256 efficiency,
        bool submitted,
        uint256 submittedAt
    ) {
        Score memory s = scores[_judge][_participant];
        return (s.problemSolving, s.codeQuality, s.efficiency, s.submitted, s.submittedAt);
    }

    function getJudgeProgress(address _judgeAddr) public view returns (uint256 submittedCount, uint256 assignedCount) {
        return (judges[_judgeAddr].submissionCount, judges[_judgeAddr].assignedParticipants.length);
    }

    function getAllJudgeProgress() public view returns (
        address[] memory judgeAddrs,
        string[] memory judgeNames,
        uint256[] memory submittedCounts,
        uint256[] memory assignedCounts
    ) {
        uint256 n = judgeList.length;
        judgeAddrs = judgeList;
        judgeNames = new string[](n);
        submittedCounts = new uint256[](n);
        assignedCounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            judgeNames[i] = judges[judgeList[i]].name;
            submittedCounts[i] = judges[judgeList[i]].submissionCount;
            assignedCounts[i] = judges[judgeList[i]].assignedParticipants.length;
        }
    }

    function getAssignedParticipants(address _judge) public view returns (address[] memory) {
        return judges[_judge].assignedParticipants;
    }

    function getContestInfo() public view returns (
        string memory name,
        string memory description,
        Phase currentPhase,
        uint256 startTime,
        uint256 participantCount,
        uint256 judgeCount
    ) {
        return (contestName, contestDescription, phase, contestStartTime, participantList.length, judgeList.length);
    }

    function isFullyEvaluated() public view returns (bool) {
        return allJudgesCompleted();
    }

    function hasJudgeCompleted(address _judge) public view returns (bool) {
        Judge storage j = judges[_judge];
        return j.assignedParticipants.length > 0 && j.submissionCount == j.assignedParticipants.length;
    }

    function allJudgesCompleted() public view returns (bool) {
        if (judgeList.length == 0) return false;
        for (uint256 i = 0; i < judgeList.length; i++) {
            if (!hasJudgeCompleted(judgeList[i])) return false;
        }
        return true;
    }
}
