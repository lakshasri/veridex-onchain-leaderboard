const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "../artifacts/contracts/ContestJudging.sol/ContestJudging.json");
const destDir = path.join(__dirname, "../frontend/src/abi");
const dest = path.join(destDir, "ContestJudging.json");

if (!fs.existsSync(src)) {
  console.warn("copy-abi: artifact missing, run `npm run compile` first");
  process.exit(0);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("Copied ABI to frontend/src/abi/ContestJudging.json");
