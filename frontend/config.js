// Replace with the deployed contract address after deploying via Remix + Ganache
const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";

// Ganache local RPC
const RPC_URL = "http://127.0.0.1:7545";

const NETWORK_NAME = "Ganache Local";

// Phase constants matching the contract's Phase enum
const PHASE = {
    REGISTRATION: 0,
    SCORING: 1,
    FINALIZED: 2
};

const PHASE_LABELS = {
    0: "Registration",
    1: "Scoring In Progress",
    2: "Finalized"
};
