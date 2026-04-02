// ============================================================
//  VERIDEX — app.js
//  Ethers.js v5  |  Ganache + MetaMask
// ============================================================

// --- Global State ---
let provider;
let signer;
let contract;
let userAddress = null;
let currentRole = 'Public';
let contractWeights = { ps: 40, cq: 30, eff: 30 };
let currentScoringParticipant = null;
let judgeListCache = [];

// ============================================================
//  WEB3 CONNECTION
// ============================================================

async function connectWallet() {
    if (!window.ethereum) {
        showToast('MetaMask not detected. Please install MetaMask.', 'error');
        return;
    }
    try {
        await window.ethereum.request({ method: 'eth_requestAccounts' });
        provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();
        userAddress = await signer.getAddress();

        document.getElementById('walletAddressDisplay').textContent =
            userAddress.slice(0, 6) + '...' + userAddress.slice(-4);
        document.getElementById('connectWalletBtn').textContent = 'Connected';
        document.getElementById('connectWalletBtn').disabled = true;

        await initContract();
        await detectRole();
        await updateUIPanels();

        window.ethereum.on('accountsChanged', async () => {
            showToast('Wallet switched — reloading role.', 'info');
            provider = new ethers.providers.Web3Provider(window.ethereum);
            signer = provider.getSigner();
            userAddress = await signer.getAddress();
            contract = contract.connect(signer);
            document.getElementById('walletAddressDisplay').textContent =
                userAddress.slice(0, 6) + '...' + userAddress.slice(-4);
            await detectRole();
            await updateUIPanels();
        });
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

async function initContract() {
    contract = new ethers.Contract(CONTRACT_ADDRESS, window.contractABI, signer);

    // Cache weights once
    try {
        const [ps, cq, eff] = await Promise.all([
            contract.weightProblemSolving(),
            contract.weightCodeQuality(),
            contract.weightEfficiency()
        ]);
        contractWeights = {
            ps: ps.toNumber(),
            cq: cq.toNumber(),
            eff: eff.toNumber()
        };
        // Update weight hints in scoring modal
        document.getElementById('wPS').textContent = `(weight: ${contractWeights.ps}%)`;
        document.getElementById('wCQ').textContent = `(weight: ${contractWeights.cq}%)`;
        document.getElementById('wEff').textContent = `(weight: ${contractWeights.eff}%)`;
    } catch (_) {}

    // Real-time event listeners
    contract.on('ScoreSubmitted', async (judge, participant, aggregate) => {
        showToast(`Score submitted for ${shortAddr(participant)}`, 'info');
        await updateJudgeProgress();
        await fetchAndRenderLeaderboard();
        if (currentRole === 'Judge' && judge.toLowerCase() === userAddress.toLowerCase()) {
            await fetchAssignedParticipants();
        }
        await checkFinalizeEligibility();
    });

    contract.on('ContestFinalized', async () => {
        showToast('Contest finalized! Results are now locked.', 'success');
        await updateUIPanels();
        await fetchAndRenderLeaderboard();
    });

    contract.on('ParticipantRegistered', async () => {
        await refreshContestInfoBar();
    });

    contract.on('JudgeRegistered', async () => {
        await refreshContestInfoBar();
    });
}

async function detectRole() {
    if (!contract || !userAddress) return;
    try {
        const organizer = await contract.organizer();
        if (organizer.toLowerCase() === userAddress.toLowerCase()) {
            currentRole = 'Organizer';
            setBadge('Organizer', 'badge-organizer');
            return;
        }

        // Rebuild judgeList cache
        judgeListCache = [];
        let i = 0;
        while (true) {
            try {
                const addr = await contract.judgeList(i);
                judgeListCache.push(addr.toLowerCase());
                i++;
            } catch (_) { break; }
        }

        if (judgeListCache.includes(userAddress.toLowerCase())) {
            currentRole = 'Judge';
            setBadge('Judge', 'badge-judge');
            return;
        }

        // Check participant list
        let j = 0;
        while (true) {
            try {
                const addr = await contract.participantList(j);
                if (addr.toLowerCase() === userAddress.toLowerCase()) {
                    currentRole = 'Participant';
                    setBadge('Participant', 'badge-participant');
                    return;
                }
                j++;
            } catch (_) { break; }
        }

        currentRole = 'Public';
        setBadge('Public', 'badge-public');
    } catch (err) {
        console.error('detectRole error:', err);
    }
}

function setBadge(label, cls) {
    const badge = document.getElementById('roleBadge');
    badge.textContent = label;
    badge.className = `role-badge ${cls}`;
    badge.classList.remove('hidden');
}

// ============================================================
//  ORGANIZER FUNCTIONS
// ============================================================

async function handleRegisterParticipant() {
    const addr = document.getElementById('regParticipantAddr').value.trim();
    const name = document.getElementById('regParticipantName').value.trim();
    if (!addr || !name) { showToast('Please fill in both address and name.', 'error'); return; }
    try {
        const tx = await contract.registerParticipant(addr, name);
        showToast('Transaction sent — waiting for confirmation...', 'info');
        await tx.wait();
        showToast(`Participant "${name}" registered successfully.`, 'success');
        document.getElementById('regParticipantAddr').value = '';
        document.getElementById('regParticipantName').value = '';
        await refreshContestInfoBar();
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

async function handleRegisterJudge() {
    const addr = document.getElementById('regJudgeAddr').value.trim();
    const name = document.getElementById('regJudgeName').value.trim();
    if (!addr || !name) { showToast('Please fill in both address and name.', 'error'); return; }
    try {
        const tx = await contract.registerJudge(addr, name);
        showToast('Transaction sent — waiting for confirmation...', 'info');
        await tx.wait();
        showToast(`Judge "${name}" registered successfully.`, 'success');
        document.getElementById('regJudgeAddr').value = '';
        document.getElementById('regJudgeName').value = '';
        await refreshContestInfoBar();
        await updateJudgeProgress();
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

async function handleAssignParticipants() {
    const judgeAddr = document.getElementById('assignJudgeAddr').value.trim();
    const raw = document.getElementById('assignParticipantAddrs').value.trim();
    if (!judgeAddr || !raw) { showToast('Please fill in judge address and participant addresses.', 'error'); return; }
    const participantAddrs = raw.split(',').map(a => a.trim()).filter(a => a.length > 0);
    if (participantAddrs.length === 0) { showToast('No valid participant addresses found.', 'error'); return; }
    try {
        const tx = await contract.assignParticipantsToJudge(judgeAddr, participantAddrs);
        showToast('Transaction sent — waiting for confirmation...', 'info');
        await tx.wait();
        showToast(`Assigned ${participantAddrs.length} participant(s) to judge.`, 'success');
        document.getElementById('assignJudgeAddr').value = '';
        document.getElementById('assignParticipantAddrs').value = '';
        await updateJudgeProgress();
        await refreshContestInfoBar();
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

async function handleFinalizeContest() {
    try {
        const tx = await contract.finalizeResults();
        showToast('Finalization transaction sent...', 'info');
        await tx.wait();
        showToast('Contest finalized! Leaderboard is now permanently locked.', 'success');
        await updateUIPanels();
        await fetchAndRenderLeaderboard();
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

async function checkFinalizeEligibility() {
    try {
        const done = await contract.allJudgesCompleted();
        const phaseVal = await contract.phase();
        const btn = document.getElementById('finalizeBtn');
        const check = document.getElementById('checkAllJudgesDone');
        if (done && phaseVal < 2) {
            btn.disabled = false;
            check.innerHTML = '<span class="check-icon">&#9745;</span> All judges completed';
            check.classList.add('check-done');
        } else {
            btn.disabled = true;
            check.innerHTML = '<span class="check-icon">&#9744;</span> All judges completed';
            check.classList.remove('check-done');
        }
    } catch (_) {}
}

// ============================================================
//  JUDGE FUNCTIONS
// ============================================================

async function fetchAssignedParticipants() {
    if (!contract || !userAddress) return;
    const tbody = document.getElementById('assignedParticipantsBody');
    try {
        const assignedAddrs = await contract.getAssignedParticipants(userAddress);
        if (assignedAddrs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No participants assigned to you yet.</td></tr>';
            return;
        }

        let submitted = 0;
        let rows = '';
        for (let i = 0; i < assignedAddrs.length; i++) {
            const addr = assignedAddrs[i];
            const pData = await contract.participants(addr);
            const scoreData = await contract.getScoreByJudge(userAddress, addr);
            const isSubmitted = scoreData.submitted;
            if (isSubmitted) submitted++;

            rows += `
                <tr class="${isSubmitted ? 'row-scored' : ''}">
                    <td>${i + 1}</td>
                    <td>${pData.name}</td>
                    <td class="addr-cell">${shortAddr(addr)}</td>
                    <td>${isSubmitted
                        ? '<span class="badge-submitted">Submitted</span>'
                        : '<span class="badge-pending">Pending</span>'}</td>
                    <td>${isSubmitted
                        ? `<button class="btn btn-ghost btn-sm" onclick="openBreakdownForJudge('${addr}', '${pData.name}')">View</button>`
                        : `<button class="btn btn-primary btn-sm" onclick="openScoreModal('${addr}', '${pData.name}')">Score</button>`}</td>
                </tr>`;
        }
        tbody.innerHTML = rows;

        const pct = assignedAddrs.length > 0 ? Math.round((submitted / assignedAddrs.length) * 100) : 0;
        document.getElementById('judgeProgressText').textContent =
            `${submitted} of ${assignedAddrs.length} participants scored`;
        document.getElementById('judgeProgressFill').style.width = pct + '%';
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error loading assignments.</td></tr>';
        console.error(err);
    }
}

// ============================================================
//  SCORE MODAL
// ============================================================

function openScoreModal(participantAddress, participantName) {
    currentScoringParticipant = participantAddress;
    document.getElementById('modalParticipantName').textContent = participantName;
    document.getElementById('modalParticipantAddr').textContent = shortAddr(participantAddress);

    ['PS', 'CQ', 'Eff'].forEach(key => {
        document.getElementById(`slider${key}`).value = 0;
        document.getElementById(`num${key}`).value = 0;
    });
    updateWeightedPreview();
    document.getElementById('scoreModal').classList.remove('hidden');
}

function closeScoreModal() {
    document.getElementById('scoreModal').classList.add('hidden');
    currentScoringParticipant = null;
}

function syncScore(source) {
    if (source === 'PS')     document.getElementById('numPS').value  = document.getElementById('sliderPS').value;
    if (source === 'PSNum')  document.getElementById('sliderPS').value = clamp(document.getElementById('numPS').value);
    if (source === 'CQ')     document.getElementById('numCQ').value  = document.getElementById('sliderCQ').value;
    if (source === 'CQNum')  document.getElementById('sliderCQ').value = clamp(document.getElementById('numCQ').value);
    if (source === 'Eff')    document.getElementById('numEff').value  = document.getElementById('sliderEff').value;
    if (source === 'EffNum') document.getElementById('sliderEff').value = clamp(document.getElementById('numEff').value);
    updateWeightedPreview();
}

function updateWeightedPreview() {
    const ps  = parseInt(document.getElementById('numPS').value)  || 0;
    const cq  = parseInt(document.getElementById('numCQ').value)  || 0;
    const eff = parseInt(document.getElementById('numEff').value) || 0;
    const weighted = Math.round((ps * contractWeights.ps + cq * contractWeights.cq + eff * contractWeights.eff) / 100);
    document.getElementById('weightedPreview').textContent = weighted;
}

async function handleSubmitScore() {
    if (!currentScoringParticipant) return;
    const ps  = parseInt(document.getElementById('numPS').value)  || 0;
    const cq  = parseInt(document.getElementById('numCQ').value)  || 0;
    const eff = parseInt(document.getElementById('numEff').value) || 0;

    if (ps < 0 || ps > 100 || cq < 0 || cq > 100 || eff < 0 || eff > 100) {
        showToast('All scores must be between 0 and 100.', 'error');
        return;
    }
    try {
        const tx = await contract.submitScore(currentScoringParticipant, ps, cq, eff);
        showToast('Score transaction sent...', 'info');
        await tx.wait();
        showToast('Score submitted successfully!', 'success');
        closeScoreModal();
        await fetchAssignedParticipants();
        await fetchAndRenderLeaderboard();
    } catch (err) {
        showToast(parseError(err), 'error');
    }
}

// ============================================================
//  BREAKDOWN MODAL
// ============================================================

async function openBreakdownForJudge(participantAddr, participantName) {
    await openBreakdownModal(participantAddr, participantName);
}

async function openBreakdownModal(participantAddr, participantName) {
    document.getElementById('breakdownParticipantName').textContent = participantName || shortAddr(participantAddr);
    const tbody = document.getElementById('breakdownBody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    document.getElementById('breakdownModal').classList.remove('hidden');

    try {
        let rows = '';
        for (const judgeAddr of judgeListCache) {
            const judgeData = await contract.judges(judgeAddr);
            const scoreData = await contract.getScoreByJudge(judgeAddr, participantAddr);
            if (!scoreData.submitted) continue;

            const ps  = scoreData.problemSolving.toNumber();
            const cq  = scoreData.codeQuality.toNumber();
            const eff = scoreData.efficiency.toNumber();
            const weighted = Math.round((ps * contractWeights.ps + cq * contractWeights.cq + eff * contractWeights.eff) / 100);
            const ts = scoreData.submittedAt.toNumber();
            const timeStr = ts > 0 ? new Date(ts * 1000).toLocaleString() : '—';

            rows += `
                <tr>
                    <td>${judgeData.name || shortAddr(judgeAddr)}</td>
                    <td>${ps}</td>
                    <td>${cq}</td>
                    <td>${eff}</td>
                    <td><strong>${weighted}</strong></td>
                    <td class="time-cell">${timeStr}</td>
                </tr>`;
        }
        tbody.innerHTML = rows || '<tr><td colspan="6" class="empty-state">No scores submitted yet.</td></tr>';
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error loading scores.</td></tr>';
        console.error(err);
    }
}

function closeBreakdownModal() {
    document.getElementById('breakdownModal').classList.add('hidden');
}

// ============================================================
//  LEADERBOARD
// ============================================================

async function fetchAndRenderLeaderboard() {
    if (!contract) return;
    const tbody = document.getElementById('leaderboardBody');
    try {
        const phaseVal = await contract.phase();
        const isFinalized = phaseVal === 2 || phaseVal.toNumber?.() === 2;

        // Update status indicator
        updateStatusIndicator(isFinalized ? 2 : phaseVal.toNumber?.() ?? phaseVal);

        const [addrs, names, totalScores, evalCounts] = await contract.getFullLeaderboard();

        if (addrs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No participants registered yet.</td></tr>';
            return;
        }

        const medals = ['🥇', '🥈', '🥉'];
        let rows = '';

        for (let i = 0; i < addrs.length; i++) {
            const rank = i + 1;
            const name = names[i];
            const evalCount = evalCounts[i].toNumber ? evalCounts[i].toNumber() : Number(evalCounts[i]);
            const totalRaw = totalScores[i].toNumber ? totalScores[i].toNumber() : Number(totalScores[i]);
            const avgTotal = evalCount > 0 ? (totalRaw / evalCount).toFixed(1) : '—';
            const rankDisplay = rank <= 3 ? `${medals[rank - 1]} ${rank}` : rank;
            const rowClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';

            let psCell = '—', cqCell = '—', effCell = '—';
            if (isFinalized && evalCount > 0) {
                const [psSum, cqSum, effSum] = await contract.getParticipantScore(addrs[i]);
                psCell  = (psSum.toNumber()  / evalCount).toFixed(1);
                cqCell  = (cqSum.toNumber()  / evalCount).toFixed(1);
                effCell = (effSum.toNumber() / evalCount).toFixed(1);
            }

            rows += `
                <tr class="${rowClass} leaderboard-row"
                    onclick="isFinalized && openBreakdownModal('${addrs[i]}', '${name}')"
                    title="${isFinalized ? 'Click to view score breakdown' : ''}">
                    <td class="rank-cell">${rankDisplay}</td>
                    <td class="name-cell">${name}</td>
                    <td>${psCell}</td>
                    <td>${cqCell}</td>
                    <td>${effCell}</td>
                    <td class="total-cell">${isFinalized ? avgTotal : '—'}</td>
                </tr>`;
        }
        tbody.innerHTML = rows;
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error loading leaderboard.</td></tr>';
        console.error(err);
    }
}

// ============================================================
//  JUDGE PROGRESS (ORGANIZER VIEW)
// ============================================================

async function updateJudgeProgress() {
    if (!contract) return;
    const tbody = document.getElementById('judgeProgressBody');
    try {
        const [addrs, names, submitted, assigned] = await contract.getAllJudgeProgress();
        if (addrs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No judges registered yet.</td></tr>';
            return;
        }
        let rows = '';
        for (let i = 0; i < addrs.length; i++) {
            const sub = submitted[i].toNumber ? submitted[i].toNumber() : Number(submitted[i]);
            const asgn = assigned[i].toNumber ? assigned[i].toNumber() : Number(assigned[i]);
            const pct = asgn > 0 ? Math.round((sub / asgn) * 100) : 0;
            const done = sub === asgn && asgn > 0;
            rows += `
                <tr>
                    <td>${names[i] || '—'}</td>
                    <td class="addr-cell">${shortAddr(addrs[i])}</td>
                    <td>${sub}</td>
                    <td>${asgn}</td>
                    <td>
                        <div class="progress-track small">
                            <div class="progress-fill ${done ? 'done' : ''}" style="width:${pct}%"></div>
                        </div>
                    </td>
                    <td>${done
                        ? '<span class="badge-submitted">Complete</span>'
                        : '<span class="badge-pending">Pending</span>'}</td>
                </tr>`;
        }
        tbody.innerHTML = rows;
        await checkFinalizeEligibility();
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error loading judge progress.</td></tr>';
        console.error(err);
    }
}

// ============================================================
//  PARTICIPANT PANEL
// ============================================================

async function updateParticipantStatus() {
    if (!contract || !userAddress) return;
    const card = document.getElementById('participantStatusCard');
    try {
        const pData = await contract.participants(userAddress);
        const evalCount = pData.evaluatedCount.toNumber ? pData.evaluatedCount.toNumber() : Number(pData.evaluatedCount);

        // Count how many judges are assigned to this participant
        let assignedJudgeCount = 0;
        for (const j of judgeListCache) {
            const isAssigned = await contract.assigned(j, userAddress);
            if (isAssigned) assignedJudgeCount++;
        }

        const phaseVal = await contract.phase();
        const isFinalized = phaseVal === 2 || phaseVal.toNumber?.() === 2;

        let html = `<p><strong>Name:</strong> ${pData.name}</p>`;
        html += `<p><strong>Evaluated by:</strong> ${evalCount} / ${assignedJudgeCount} judge(s)</p>`;

        if (isFinalized && evalCount > 0) {
            const totalRaw = pData.totalScore.toNumber ? pData.totalScore.toNumber() : Number(pData.totalScore);
            const avg = (totalRaw / evalCount).toFixed(1);
            html += `<p><strong>Your weighted score:</strong> <span class="score-highlight">${avg} / 100</span></p>`;
        } else if (isFinalized && evalCount === 0) {
            html += `<p>You were not evaluated in this contest.</p>`;
        } else {
            html += `<p class="muted">Scores are hidden until the contest is finalized.</p>`;
        }

        card.innerHTML = html;
    } catch (err) {
        card.innerHTML = '<p>Error loading your status.</p>';
        console.error(err);
    }
}

// ============================================================
//  UI PANELS & STATUS
// ============================================================

async function updateUIPanels() {
    document.getElementById('organizerPanel').classList.add('hidden');
    document.getElementById('judgePanel').classList.add('hidden');
    document.getElementById('participantPanel').classList.add('hidden');

    if (!contract) return;

    await refreshContestInfoBar();
    await fetchAndRenderLeaderboard();

    if (currentRole === 'Organizer') {
        document.getElementById('organizerPanel').classList.remove('hidden');
        await updateJudgeProgress();
    } else if (currentRole === 'Judge') {
        document.getElementById('judgePanel').classList.remove('hidden');
        await fetchAssignedParticipants();
    } else if (currentRole === 'Participant') {
        document.getElementById('participantPanel').classList.remove('hidden');
        await updateParticipantStatus();
    }
}

async function refreshContestInfoBar() {
    if (!contract) return;
    try {
        const [name, desc, phaseVal, startTime, participantCount, judgeCount] = await contract.getContestInfo();
        const phase = phaseVal.toNumber ? phaseVal.toNumber() : Number(phaseVal);

        document.getElementById('contestSubtitle').textContent = desc || 'On-Chain Judging System';
        document.getElementById('contestPhase').textContent = PHASE_LABELS[phase] || 'Unknown';
        document.getElementById('contestPhase').className = `phase-badge phase-${phase}`;
        document.getElementById('contestParticipantCount').textContent =
            `${participantCount.toNumber ? participantCount.toNumber() : participantCount} participants`;
        document.getElementById('contestJudgeCount').textContent =
            `${judgeCount.toNumber ? judgeCount.toNumber() : judgeCount} judges`;
        document.getElementById('contestInfoBar').classList.remove('hidden');

        // Also update document title
        document.title = `${name} — Veridex`;
    } catch (_) {}
}

function updateStatusIndicator(phase) {
    const indicator = document.getElementById('statusIndicator');
    const label = document.getElementById('statusLabel');
    indicator.className = 'status-indicator';
    if (phase === 2) {
        label.textContent = 'FINALIZED — Results Locked';
        indicator.classList.add('finalized');
    } else if (phase === 1) {
        label.textContent = 'Scoring In Progress';
        indicator.classList.add('scoring');
    } else {
        label.textContent = 'Registration Phase';
        indicator.classList.add('pending');
    }
}

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()">×</button>`;
    container.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('toast-show'));
    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// ============================================================
//  UTILITIES
// ============================================================

function parseError(err) {
    const knownErrors = {
        'Not organizer': 'Only the organizer can perform this action.',
        'Not a judge': 'Only registered judges can perform this action.',
        'Not assigned to this participant': 'You are not assigned to judge this participant.',
        'Score already submitted': 'You have already submitted a score for this participant.',
        'Contest is finalized': 'The contest is finalized — no further changes are allowed.',
        'Not all judges have submitted': 'Finalization requires all judges to complete their evaluations.',
        'Already registered': 'This address is already registered.',
        'Participant not registered': 'One or more participants are not registered.',
        'Already assigned': 'One or more participants are already assigned to this judge.',
        'Only during Registration phase': 'Registrations are only allowed during the Registration phase.',
        'Score out of range': 'Each score must be between 0 and 100.',
        'Weights must sum to 100': 'Scoring weights must add up to 100.',
        'Judge not registered': 'The specified judge address is not registered.',
        'user rejected': 'Transaction rejected by user.',
        'User rejected': 'Transaction rejected by user.'
    };

    const raw = err?.reason || err?.data?.message || err?.message || String(err);
    for (const [key, msg] of Object.entries(knownErrors)) {
        if (raw.includes(key)) return msg;
    }
    if (raw.includes('rejected') || raw.includes('denied')) return 'Transaction rejected by user.';
    return raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
}

function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function clamp(val) {
    const n = parseInt(val);
    if (isNaN(n)) return 0;
    return Math.min(100, Math.max(0, n));
}

// ============================================================
//  INITIALIZATION
// ============================================================

window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('connectWalletBtn').addEventListener('click', connectWallet);

    fetch('contractABI.json')
        .then(res => res.json())
        .then(abi => { window.contractABI = abi; })
        .catch(err => console.error('Could not load ABI:', err));
});
