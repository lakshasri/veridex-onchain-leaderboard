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
let isContestFinalized = false;

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

        window.ethereum.on('accountsChanged', async (accounts) => {
            if (!accounts.length) {
                // MetaMask locked / disconnected
                document.getElementById('walletAddressDisplay').textContent = 'Not connected';
                document.getElementById('connectWalletBtn').textContent = 'Connect Wallet';
                document.getElementById('connectWalletBtn').disabled = false;
                document.getElementById('roleBadge').classList.add('hidden');
                currentRole = 'Public';
                return;
            }
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
        // Update weight hints in scoring modal and leaderboard headers
        document.getElementById('wPS').textContent = `(weight: ${contractWeights.ps}%)`;
        document.getElementById('wCQ').textContent = `(weight: ${contractWeights.cq}%)`;
        document.getElementById('wEff').textContent = `(weight: ${contractWeights.eff}%)`;
        document.getElementById('colPS').textContent  = `Prob. Solving (${contractWeights.ps}%)`;
        document.getElementById('colCQ').textContent  = `Code Quality (${contractWeights.cq}%)`;
        document.getElementById('colEff').textContent = `Efficiency (${contractWeights.eff}%)`;
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
        // Always rebuild judgeListCache — needed by breakdown modal for all roles
        judgeListCache = [];
        let i = 0;
        while (true) {
            try {
                const addr = await contract.judgeList(i);
                judgeListCache.push(addr.toLowerCase());
                i++;
            } catch (_) { break; }
        }

        const organizer = await contract.organizer();
        if (organizer.toLowerCase() === userAddress.toLowerCase()) {
            currentRole = 'Organizer';
            setBadge('Organizer', 'badge-organizer');
            return;
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
    if (!ethers.utils.isAddress(addr)) { showToast('Invalid Ethereum address.', 'error'); return; }
    const btn = event.currentTarget;
    setLoading(btn, true);
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
    } finally {
        setLoading(btn, false);
    }
}

async function handleRegisterJudge() {
    const addr = document.getElementById('regJudgeAddr').value.trim();
    const name = document.getElementById('regJudgeName').value.trim();
    if (!addr || !name) { showToast('Please fill in both address and name.', 'error'); return; }
    if (!ethers.utils.isAddress(addr)) { showToast('Invalid Ethereum address.', 'error'); return; }
    const btn = event.currentTarget;
    setLoading(btn, true);
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
    } finally {
        setLoading(btn, false);
    }
}

async function handleAssignParticipants() {
    const judgeAddr = document.getElementById('assignJudgeAddr').value.trim();
    const raw = document.getElementById('assignParticipantAddrs').value.trim();
    if (!judgeAddr || !raw) { showToast('Please fill in judge address and participant addresses.', 'error'); return; }
    if (!ethers.utils.isAddress(judgeAddr)) { showToast('Invalid judge address.', 'error'); return; }
    const participantAddrs = raw.split(',').map(a => a.trim()).filter(a => a.length > 0);
    if (participantAddrs.length === 0) { showToast('No valid participant addresses found.', 'error'); return; }
    const invalidAddr = participantAddrs.find(a => !ethers.utils.isAddress(a));
    if (invalidAddr) { showToast(`Invalid address: ${shortAddr(invalidAddr) || invalidAddr}`, 'error'); return; }
    const btn = event.currentTarget;
    setLoading(btn, true);
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
    } finally {
        setLoading(btn, false);
    }
}

async function handleFinalizeContest() {
    const btn = document.getElementById('finalizeBtn');
    setLoading(btn, true);
    try {
        const tx = await contract.finalizeResults();
        showToast('Finalization transaction sent...', 'info');
        await tx.wait();
        showToast('Contest finalized! Leaderboard is now permanently locked.', 'success');
        lockOrganizerForms();
        await updateUIPanels();
        await fetchAndRenderLeaderboard();
    } catch (err) {
        showToast(parseError(err), 'error');
        setLoading(btn, false);
    }
}

async function checkFinalizeEligibility() {
    try {
        const done = await contract.allJudgesCompleted();
        const phaseVal = await contract.phase();
        const phaseNum = phaseVal.toNumber ? phaseVal.toNumber() : Number(phaseVal);
        const btn = document.getElementById('finalizeBtn');
        const check = document.getElementById('checkAllJudgesDone');
        if (done && phaseNum < 2) {
            btn.disabled = false;
            check.innerHTML = '<span class="check-icon">&#9745;</span> All judges completed';
            check.classList.add('check-done');
        } else {
            btn.disabled = true;
            check.innerHTML = '<span class="check-icon">&#9744;</span> All judges completed';
            check.classList.remove('check-done');
        }
        if (phaseNum === 2) lockOrganizerForms();
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

            // When finalized, all rows show View; when already scored, show View; else Score
            const actionBtn = (isSubmitted || isContestFinalized)
                ? `<button class="btn btn-ghost btn-sm" onclick="openBreakdownForJudge('${addr}', '${pData.name}')">View</button>`
                : `<button class="btn btn-primary btn-sm" onclick="openScoreModal('${addr}', '${pData.name}')">Score</button>`;

            rows += `
                <tr class="${isSubmitted ? 'row-scored' : ''}">
                    <td>${i + 1}</td>
                    <td>${pData.name}</td>
                    <td class="addr-cell">${shortAddr(addr)}</td>
                    <td>${isSubmitted
                        ? '<span class="badge-submitted">Submitted</span>'
                        : '<span class="badge-pending">Pending</span>'}</td>
                    <td>${actionBtn}</td>
                </tr>`;
        }
        tbody.innerHTML = rows;

        const pct = assignedAddrs.length > 0 ? Math.round((submitted / assignedAddrs.length) * 100) : 0;
        document.getElementById('judgeProgressText').textContent =
            `${submitted} of ${assignedAddrs.length} participants scored`;
        document.getElementById('judgeProgressFill').style.width = pct + '%';

        // "All done!" banner when judge has completed all scoring
        if (submitted === assignedAddrs.length && !isContestFinalized) {
            const existing = document.getElementById('judgeDoneBanner');
            if (!existing) {
                const banner = document.createElement('div');
                banner.id = 'judgeDoneBanner';
                banner.className = 'judge-done-banner';
                banner.innerHTML = '<span>All participants scored!</span><small>Waiting for organizer to finalize the contest.</small>';
                document.getElementById('judgePanel').insertBefore(banner, document.querySelector('.card.full-width'));
            }
        }
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

    const submitBtn = document.querySelector('#scoreModal .modal-footer .btn-primary');
    const modalInputs = document.querySelectorAll('#scoreModal input, #scoreModal .modal-close, #scoreModal .btn-ghost');
    setLoading(submitBtn, true);
    modalInputs.forEach(el => el.disabled = true);

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
    } finally {
        setLoading(submitBtn, false);
        modalInputs.forEach(el => el.disabled = false);
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
        isContestFinalized = phaseVal === 2 || phaseVal.toNumber?.() === 2;
        const isFinalized = isContestFinalized;

        // Update status indicator
        updateStatusIndicator(isFinalized ? 2 : phaseVal.toNumber?.() ?? phaseVal);

        const [addrs, names, totalScores, evalCounts] = await contract.getFullLeaderboard();

        if (addrs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No participants registered yet.</td></tr>';
            return;
        }

        // Build sortable array from parallel arrays, then rank by descending average score
        let participants = addrs.map((addr, i) => ({
            addr,
            name: names[i],
            evalCount: evalCounts[i].toNumber ? evalCounts[i].toNumber() : Number(evalCounts[i]),
            totalRaw:  totalScores[i].toNumber ? totalScores[i].toNumber() : Number(totalScores[i]),
        }));
        participants.sort((a, b) => {
            const avgA = a.evalCount > 0 ? a.totalRaw / a.evalCount : -1;
            const avgB = b.evalCount > 0 ? b.totalRaw / b.evalCount : -1;
            return avgB - avgA;
        });

        // If finalized, batch-fetch per-criterion sums for each participant
        const criteriaMap = {};
        if (isFinalized) {
            await Promise.all(participants.map(async (p) => {
                if (p.evalCount > 0) {
                    const [psSum, cqSum, effSum] = await contract.getParticipantScore(p.addr);
                    criteriaMap[p.addr] = {
                        ps:  psSum.toNumber  ? psSum.toNumber()  : Number(psSum),
                        cq:  cqSum.toNumber  ? cqSum.toNumber()  : Number(cqSum),
                        eff: effSum.toNumber ? effSum.toNumber() : Number(effSum),
                    };
                }
            }));
        }

        const medals = ['🥇', '🥈', '🥉'];
        let rows = '';

        for (let i = 0; i < participants.length; i++) {
            const rank = i + 1;
            const { addr, name, evalCount, totalRaw } = participants[i];
            const avgTotal = evalCount > 0 ? (totalRaw / evalCount).toFixed(1) : '—';
            const rankDisplay = rank <= 3 ? `${medals[rank - 1]} ${rank}` : rank;
            const rowClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';

            let psCell = '—', cqCell = '—', effCell = '—';
            if (isFinalized && evalCount > 0 && criteriaMap[addr]) {
                psCell  = (criteriaMap[addr].ps  / evalCount).toFixed(1);
                cqCell  = (criteriaMap[addr].cq  / evalCount).toFixed(1);
                effCell = (criteriaMap[addr].eff / evalCount).toFixed(1);
            }

            rows += `
                <tr class="${rowClass} leaderboard-row${isFinalized ? ' clickable' : ''}"
                    onclick="if(isContestFinalized) openBreakdownModal('${addr}', '${name}')"
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
        if (isContestFinalized) lockOrganizerForms();
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
//  ORGANIZER UTILITIES
// ============================================================

function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Pending...';
        btn.disabled = true;
    } else {
        btn.textContent = btn.dataset.originalText || btn.textContent;
        btn.disabled = false;
    }
}

function lockOrganizerForms() {
    const panel = document.getElementById('organizerPanel');
    if (!panel) return;
    panel.querySelectorAll('input, textarea, button').forEach(el => {
        el.disabled = true;
    });
    panel.classList.add('panel-locked');
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
        .then(abi => {
            window.contractABI = abi;
            // Auto-reconnect if MetaMask already has permissions (no popup)
            if (window.ethereum) {
                window.ethereum.request({ method: 'eth_accounts' })
                    .then(accounts => { if (accounts.length > 0) connectWallet(); })
                    .catch(() => {});
            }
        })
        .catch(err => console.error('Could not load ABI:', err));
});
