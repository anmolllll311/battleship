/**
 * Aegis Battleship Game Controller & UI Orchestrator
 * Integrates WebRTC P2P transport, SHA-256 Commitments, particle VFX canvas, and board interactions.
 */

// Standard Fleet Definition
const FLEET_DEFINITIONS = [
  { id: 'carrier', name: 'Carrier', length: 5 },
  { id: 'battleship', name: 'Battleship', length: 4 },
  { id: 'cruiser', name: 'Cruiser', length: 3 },
  { id: 'submarine', name: 'Submarine', length: 3 },
  { id: 'destroyer', name: 'Destroyer', length: 2 }
];

class BattleshipGame {
  constructor() {
    this.crypto = new BattleshipCrypto();
    this.rtc = null;

    // Player State
    this.playerBoard = new Array(100).fill(0); // 0 = empty, 1 = ship
    this.playerShipPlacements = []; // [{ id, length, coords: [idx], hits: 0, sunk: false }]
    this.selectedShipId = 'carrier';
    this.isHorizontal = true;
    this.fleetLocked = false;

    // Peer State
    this.peerBoardHits = new Array(100).fill(null); // null = unknown, 'hit', 'miss'
    this.peerFleetStatus = {
      carrier: { hits: 0, length: 5, sunk: false },
      battleship: { hits: 0, length: 4, sunk: false },
      cruiser: { hits: 0, length: 3, sunk: false },
      submarine: { hits: 0, length: 3, sunk: false },
      destroyer: { hits: 0, length: 2, sunk: false }
    };

    // Match Flow State
    this.isConnected = false;
    this.peerReady = false;
    this.isMyTurn = false;
    this.gameStarted = false;
    this.gameOver = false;
    this.awaitingAttackResponse = false;

    // Video stream for QR scanner
    this.activeVideoStream = null;
    this.qrScanInterval = null;

    // Canvas particle engine
    this.particles = [];
    this.initCanvasFx();

    // DOM References
    this.dom = {
      playerGrid: document.getElementById('player-grid'),
      enemyGrid: document.getElementById('enemy-grid'),
      dockPanel: document.getElementById('dock-panel'),
      btnLockFleet: document.getElementById('btn-lock-fleet'),
      btnRotate: document.getElementById('btn-rotate'),
      rotText: document.getElementById('rot-text'),
      btnRandomize: document.getElementById('btn-randomize'),
      btnClearFleet: document.getElementById('btn-clear-fleet'),
      shipPicker: document.getElementById('ship-picker'),
      intelText: document.getElementById('intel-text'),
      combatFeed: document.getElementById('combat-feed'),
      turnIndicator: document.getElementById('turn-indicator'),
      turnText: document.getElementById('turn-text'),
      connBadge: document.getElementById('conn-badge'),
      connText: document.getElementById('conn-text'),
      peerStatusLabel: document.getElementById('peer-status-label'),
      btnOpenConnect: document.getElementById('btn-open-connect'),
      connectModal: document.getElementById('connect-modal'),
      btnCloseModal: document.getElementById('btn-close-modal'),
      btnSound: document.getElementById('btn-sound'),
      // Host / Join DOM
      tabHost: document.getElementById('tab-host'),
      tabJoin: document.getElementById('tab-join'),
      hostView: document.getElementById('host-view'),
      joinView: document.getElementById('join-view'),
      btnCreateOffer: document.getElementById('btn-create-offer'),
      hostOfferBox: document.getElementById('host-offer-box'),
      hostOfferCode: document.getElementById('host-offer-code'),
      btnCopyHostOffer: document.getElementById('btn-copy-host-offer'),
      hostAnswerBox: document.getElementById('host-answer-box'),
      hostAnswerInput: document.getElementById('host-answer-input'),
      btnAcceptAnswer: document.getElementById('btn-accept-answer'),
      btnScanAnswerQr: document.getElementById('btn-scan-answer-qr'),
      joinOfferInput: document.getElementById('join-offer-input'),
      btnGenerateAnswer: document.getElementById('btn-generate-answer'),
      btnScanOfferQr: document.getElementById('btn-scan-offer-qr'),
      joinAnswerBox: document.getElementById('join-answer-box'),
      joinAnswerCode: document.getElementById('join-answer-code'),
      btnCopyJoinAnswer: document.getElementById('btn-copy-join-answer'),
      // Camera DOM
      cameraModal: document.getElementById('camera-modal'),
      cameraVideo: document.getElementById('camera-video'),
      cameraCanvas: document.getElementById('camera-canvas'),
      cameraStatus: document.getElementById('camera-status'),
      btnCloseCamera: document.getElementById('btn-close-camera'),
      // Game Over DOM
      gameOverModal: document.getElementById('gameover-modal'),
      gameOverTitle: document.getElementById('gameover-title'),
      gameOverDesc: document.getElementById('gameover-desc'),
      auditLocalHash: document.getElementById('audit-local-hash'),
      auditPeerHash: document.getElementById('audit-peer-hash'),
      btnRematch: document.getElementById('btn-rematch')
    };

    this.initGrids();
    this.bindEvents();
    this.randomizeFleet(); // default randomized placement for instant play
  }

  // Generate 10x10 grids and coordinate axes (A-J, 1-10)
  initGrids() {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const coordTops = [document.getElementById('coord-top-player'), document.getElementById('coord-top-enemy')];
    const coordLefts = [document.getElementById('coord-left-player'), document.getElementById('coord-left-enemy')];

    coordTops.forEach(top => {
      top.innerHTML = '';
      for (let i = 1; i <= 10; i++) {
        const span = document.createElement('span');
        span.textContent = i;
        top.appendChild(span);
      }
    });

    coordLefts.forEach(left => {
      left.innerHTML = '';
      letters.forEach(letter => {
        const span = document.createElement('span');
        span.textContent = letter;
        left.appendChild(span);
      });
    });

    // Populate player board cells
    this.dom.playerGrid.innerHTML = '';
    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('div');
      cell.classList.add('cell');
      cell.dataset.index = i;
      this.dom.playerGrid.appendChild(cell);
    }

    // Populate radar targeting cells
    this.dom.enemyGrid.querySelectorAll('.cell').forEach(c => c.remove());
    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('div');
      cell.classList.add('cell');
      cell.dataset.index = i;
      this.dom.enemyGrid.appendChild(cell);
    }
  }

  // Bind UI buttons, keyboard hotkeys, and inputs
  bindEvents() {
    // Sound Toggle
    this.dom.btnSound.addEventListener('click', () => {
      const isMuted = window.soundEngine.toggleMute();
      this.dom.btnSound.textContent = isMuted ? '🔇' : '🔊';
    });

    // Rotation controls
    this.dom.btnRotate.addEventListener('click', () => this.toggleRotation());
    window.addEventListener('keydown', (e) => {
      if (['r', 'R', ' '].includes(e.key) && !this.fleetLocked && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        this.toggleRotation();
      }
    });

    // Fleet Placement Dock
    this.dom.shipPicker.querySelectorAll('.ship-item').forEach(item => {
      item.addEventListener('click', () => {
        if (this.fleetLocked) return;
        this.dom.shipPicker.querySelectorAll('.ship-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        this.selectedShipId = item.dataset.ship;
      });
    });

    this.dom.btnRandomize.addEventListener('click', () => {
      if (!this.fleetLocked) this.randomizeFleet();
    });

    this.dom.btnClearFleet.addEventListener('click', () => {
      if (!this.fleetLocked) this.clearFleet();
    });

    this.dom.btnLockFleet.addEventListener('click', () => this.lockInFleet());

    // Grid Hover & Placement Interactions
    this.dom.playerGrid.addEventListener('mouseover', (e) => this.handlePlacementHover(e));
    this.dom.playerGrid.addEventListener('mouseleave', () => this.clearPlacementPreview());
    this.dom.playerGrid.addEventListener('click', (e) => this.handlePlacementClick(e));

    // Radar Targeting Interaction
    this.dom.enemyGrid.addEventListener('click', (e) => this.handleRadarTargetClick(e));

    // Connect Modal toggles
    this.dom.btnOpenConnect.addEventListener('click', () => {
      this.dom.connectModal.classList.remove('hidden');
    });

    this.dom.btnCloseModal.addEventListener('click', () => {
      this.dom.connectModal.classList.add('hidden');
    });

    this.dom.tabHost.addEventListener('click', () => {
      this.dom.tabHost.classList.add('active');
      this.dom.tabJoin.classList.remove('active');
      this.dom.hostView.classList.remove('hidden');
      this.dom.joinView.classList.add('hidden');
    });

    this.dom.tabJoin.addEventListener('click', () => {
      this.dom.tabJoin.classList.add('active');
      this.dom.tabHost.classList.remove('active');
      this.dom.joinView.classList.remove('hidden');
      this.dom.hostView.classList.add('hidden');
    });

    // P2P Host / Join Actions
    this.dom.btnCreateOffer.addEventListener('click', () => this.handleCreateHostOffer());
    this.dom.btnAcceptAnswer.addEventListener('click', () => this.handleAcceptPeerAnswer());
    this.dom.btnGenerateAnswer.addEventListener('click', () => this.handleGenerateJoinAnswer());

    // Copy buttons
    this.dom.btnCopyHostOffer.addEventListener('click', () => {
      navigator.clipboard.writeText(this.dom.hostOfferCode.value);
      this.dom.btnCopyHostOffer.textContent = 'Copied!';
      setTimeout(() => this.dom.btnCopyHostOffer.textContent = 'Copy', 1500);
    });

    this.dom.btnCopyJoinAnswer.addEventListener('click', () => {
      navigator.clipboard.writeText(this.dom.joinAnswerCode.value);
      this.dom.btnCopyJoinAnswer.textContent = 'Copied!';
      setTimeout(() => this.dom.btnCopyJoinAnswer.textContent = 'Copy', 1500);
    });

    // QR Scanning
    this.dom.btnScanOfferQr.addEventListener('click', () => this.openCameraScanner((code) => {
      this.dom.joinOfferInput.value = code;
      this.handleGenerateJoinAnswer();
    }));

    this.dom.btnScanAnswerQr.addEventListener('click', () => this.openCameraScanner((code) => {
      this.dom.hostAnswerInput.value = code;
      this.handleAcceptPeerAnswer();
    }));

    this.dom.btnCloseCamera.addEventListener('click', () => this.closeCameraScanner());

    // Rematch
    this.dom.btnRematch.addEventListener('click', () => {
      this.dom.gameOverModal.classList.add('hidden');
      this.resetGame();
    });
  }

  toggleRotation() {
    this.isHorizontal = !this.isHorizontal;
    this.dom.rotText.textContent = this.isHorizontal ? 'HORIZONTAL' : 'VERTICAL';
  }

  // --- Fleet Placement Logic ---

  getShipCoords(startIndex, length, isHorizontal) {
    const x = startIndex % 10;
    const y = Math.floor(startIndex / 10);
    const coords = [];

    if (isHorizontal) {
      if (x + length > 10) return null; // out of horizontal bounds
      for (let i = 0; i < length; i++) coords.push(startIndex + i);
    } else {
      if (y + length > 10) return null; // out of vertical bounds
      for (let i = 0; i < length; i++) coords.push(startIndex + i * 10);
    }
    return coords;
  }

  canPlaceShip(coords, excludeShipId = null) {
    if (!coords) return false;
    for (const ship of this.playerShipPlacements) {
      if (ship.id === excludeShipId) continue;
      for (const c of coords) {
        if (ship.coords.includes(c)) return false;
      }
    }
    return true;
  }

  handlePlacementHover(e) {
    if (this.fleetLocked) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const startIndex = parseInt(cell.dataset.index, 10);
    const def = FLEET_DEFINITIONS.find(s => s.id === this.selectedShipId);
    if (!def) return;

    this.clearPlacementPreview();
    const coords = this.getShipCoords(startIndex, def.length, this.isHorizontal);
    const isValid = this.canPlaceShip(coords, def.id);

    if (coords) {
      coords.forEach(idx => {
        const targetCell = this.dom.playerGrid.querySelector(`[data-index="${idx}"]`);
        if (targetCell) {
          targetCell.classList.add(isValid ? 'placement-preview-valid' : 'placement-preview-invalid');
        }
      });
    }
  }

  clearPlacementPreview() {
    this.dom.playerGrid.querySelectorAll('.cell').forEach(c => {
      c.classList.remove('placement-preview-valid', 'placement-preview-invalid');
    });
  }

  handlePlacementClick(e) {
    if (this.fleetLocked) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const startIndex = parseInt(cell.dataset.index, 10);
    const def = FLEET_DEFINITIONS.find(s => s.id === this.selectedShipId);
    if (!def) return;

    const coords = this.getShipCoords(startIndex, def.length, this.isHorizontal);
    if (!this.canPlaceShip(coords, def.id)) {
      window.soundEngine.playMiss();
      return;
    }

    // Place or update ship
    this.playerShipPlacements = this.playerShipPlacements.filter(s => s.id !== def.id);
    this.playerShipPlacements.push({
      id: def.id,
      name: def.name,
      length: def.length,
      coords,
      hits: 0,
      sunk: false
    });

    window.soundEngine.playSonar();
    this.updatePlayerGridUI();

    // Auto-advance to next unplaced ship
    const placedIds = this.playerShipPlacements.map(s => s.id);
    const nextUnplaced = FLEET_DEFINITIONS.find(s => !placedIds.includes(s.id));
    if (nextUnplaced) {
      this.selectedShipId = nextUnplaced.id;
      this.dom.shipPicker.querySelectorAll('.ship-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.ship === nextUnplaced.id);
      });
    }
  }

  randomizeFleet() {
    this.playerShipPlacements = [];
    for (const def of FLEET_DEFINITIONS) {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 100) {
        attempts++;
        const isHorizontal = Math.random() < 0.5;
        const startIndex = Math.floor(Math.random() * 100);
        const coords = this.getShipCoords(startIndex, def.length, isHorizontal);
        if (this.canPlaceShip(coords)) {
          this.playerShipPlacements.push({
            id: def.id,
            name: def.name,
            length: def.length,
            coords,
            hits: 0,
            sunk: false
          });
          placed = true;
        }
      }
    }
    this.updatePlayerGridUI();
    window.soundEngine.playSonar();
  }

  clearFleet() {
    this.playerShipPlacements = [];
    this.updatePlayerGridUI();
  }

  updatePlayerGridUI() {
    this.playerBoard.fill(0);
    this.dom.playerGrid.querySelectorAll('.cell').forEach(c => {
      c.classList.remove('has-ship');
    });

    for (const ship of this.playerShipPlacements) {
      for (const idx of ship.coords) {
        this.playerBoard[idx] = 1;
        const cell = this.dom.playerGrid.querySelector(`[data-index="${idx}"]`);
        if (cell) cell.classList.add('has-ship');
      }
    }

    const placedCount = this.playerShipPlacements.length;
    this.dom.btnLockFleet.disabled = placedCount < 5;
    this.dom.btnLockFleet.textContent = placedCount === 5
      ? '🔒 LOCK IN FLEET COMMITMENT (READY)'
      : `LOCK IN FLEET COMMITMENT (${placedCount}/5)`;

    // Update dock items
    this.dom.shipPicker.querySelectorAll('.ship-item').forEach(item => {
      const isPlaced = this.playerShipPlacements.some(s => s.id === item.dataset.ship);
      item.classList.toggle('placed', isPlaced);
    });
  }

  async lockInFleet() {
    if (this.playerShipPlacements.length < 5) return;
    this.fleetLocked = true;
    this.dom.dockPanel.style.display = 'none';

    // Compute cryptographic commitment
    this.addCombatLog('system', 'Generating SHA-256 cryptographic commitments for defense grid...');
    const commitment = await this.crypto.commitBoard(this.playerBoard);
    this.addCombatLog('crypto', `Board cryptographically sealed. Root: ${commitment.rootHash.substring(0, 16)}...`);

    this.setIntel('Fleet sealed with SHA-256 hash. Ready for battle.');
    window.soundEngine.playSonar();

    // If already connected, notify peer of commitment
    if (this.isConnected) {
      this.sendPacket({
        action: 'COMMITMENT',
        rootHash: commitment.rootHash,
        cellHashes: commitment.cellHashes
      });
      this.checkBattleStart();
    }
  }

  // --- WebRTC Signaling & Connection Handlers ---

  async handleCreateHostOffer() {
    try {
      this.initWebRTC();
      this.dom.btnCreateOffer.disabled = true;
      this.dom.btnCreateOffer.textContent = 'Generating... (gathering STUN candidates)';
      this.setIntel('Gathering network addresses and generating Host invitation...');

      const offerCode = await this.rtc.initHost();

      this.dom.hostOfferCode.value = offerCode;
      this.dom.hostOfferBox.classList.remove('hidden');
      this.dom.hostAnswerBox.classList.remove('hidden');
      this.dom.btnCreateOffer.textContent = 'Host Invite Ready';

      // Render QR code safely
      const qrCanvas = document.getElementById('qr-offer-canvas');
      if (window.QRCode && qrCanvas) {
        try {
          QRCode.toCanvas(qrCanvas, offerCode, { width: 200, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
        } catch (qrErr) {
          console.warn("QR canvas generation error:", qrErr);
        }
      }

      this.setIntel('Host invite generated. Share the code or QR with your opponent.');
      this.addCombatLog('info', 'Host invite generated. Awaiting peer response.');
    } catch (err) {
      this.setIntel('Host generation failed: ' + err.message);
      this.dom.btnCreateOffer.disabled = false;
    }
  }

  async handleAcceptPeerAnswer() {
    const answerCode = this.dom.hostAnswerInput.value.trim();
    if (!answerCode) {
      alert("Please paste the answer code or scan the QR code.");
      return;
    }
    try {
      this.dom.btnAcceptAnswer.disabled = true;
      this.dom.btnAcceptAnswer.textContent = 'Connecting...';
      await this.rtc.acceptAnswer(answerCode);
      this.setIntel('Answer accepted. Finalizing direct peer connection...');
    } catch (err) {
      this.dom.btnAcceptAnswer.disabled = false;
      this.dom.btnAcceptAnswer.textContent = 'Connect';
      alert("Failed to connect: " + err.message);
    }
  }

  async handleGenerateJoinAnswer() {
    const offerCode = this.dom.joinOfferInput.value.trim();
    if (!offerCode) {
      alert("Please paste the host invite code or scan their QR code.");
      return;
    }
    try {
      this.initWebRTC();
      this.dom.btnGenerateAnswer.disabled = true;
      this.dom.btnGenerateAnswer.textContent = 'Generating Answer...';

      const answerCode = await this.rtc.initJoiner(offerCode);

      this.dom.joinAnswerCode.value = answerCode;
      this.dom.joinAnswerBox.classList.remove('hidden');
      this.dom.btnGenerateAnswer.textContent = 'Answer Ready';

      // Render QR code safely
      const qrCanvas = document.getElementById('qr-answer-canvas');
      if (window.QRCode && qrCanvas) {
        try {
          QRCode.toCanvas(qrCanvas, answerCode, { width: 200, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
        } catch (qrErr) {
          console.warn("QR answer canvas generation error:", qrErr);
        }
      }

      this.setIntel('Answer generated! Hand this answer back to the Host to complete link.');
      this.addCombatLog('info', 'Joiner answer ready. Awaiting Host confirmation.');
    } catch (err) {
      this.dom.btnGenerateAnswer.disabled = false;
      this.dom.btnGenerateAnswer.textContent = 'Accept & Respond';
      alert("Failed to generate answer: " + err.message);
    }
  }

  initWebRTC() {
    if (this.rtc) this.rtc.close();

    this.rtc = new WebRTCEngine({
      onStateChange: (state) => this.handleConnectionState(state),
      onMessage: (packet) => this.handlePeerMessage(packet),
      onError: (err) => {
        this.addCombatLog('system', '[COMM ERR] ' + err);
        this.setIntel(err);
      }
    });
  }

  handleConnectionState(state) {
    if (state === 'connected') {
      this.isConnected = true;
      this.dom.connBadge.className = 'badge badge-connected';
      this.dom.connText.textContent = 'P2P ENCRYPTED LINK ONLINE';
      this.dom.peerStatusLabel.textContent = 'ONLINE (DIRECT)';
      this.dom.connectModal.classList.add('hidden');
      window.soundEngine.playConnect();

      this.addCombatLog('info', 'Zero-latency WebRTC data channel established directly with opponent!');
      this.setIntel('P2P Link established! Lock in your fleet defense to start battle.');

      // If already committed fleet, send commitment now
      if (this.fleetLocked) {
        this.sendPacket({
          action: 'COMMITMENT',
          rootHash: this.crypto.localRootCommitment,
          cellHashes: this.crypto.localCellCommitments
        });
      }
    } else {
      this.isConnected = false;
      this.dom.connBadge.className = 'badge badge-disconnected';
      this.dom.connText.textContent = 'OFFLINE';
      this.dom.peerStatusLabel.textContent = 'DISCONNECTED';
      this.addCombatLog('system', 'Peer disconnected.');
    }
  }

  sendPacket(data) {
    if (this.rtc) this.rtc.send(data);
  }

  // --- In-Game P2P Messaging & Combat Protocol ---

  async handlePeerMessage(packet) {
    switch (packet.action) {
      case 'COMMITMENT':
        try {
          await this.crypto.setPeerCommitment(packet.rootHash, packet.cellHashes);
          this.peerReady = true;
          this.addCombatLog('crypto', `Received opponent's sealed board hash: ${packet.rootHash.substring(0, 16)}...`);
          this.checkBattleStart();
        } catch (err) {
          alert("Security verification failed: " + err.message);
        }
        break;

      case 'ATTACK':
        this.handleIncomingAttack(packet.index);
        break;

      case 'ATTACK_RESULT':
        this.handleIncomingAttackResult(packet);
        break;

      case 'REMATCH_OFFER':
        this.addCombatLog('info', 'Opponent requested a rematch.');
        this.resetGame();
        break;
    }
  }

  checkBattleStart() {
    if (this.fleetLocked && this.peerReady && !this.gameStarted) {
      this.gameStarted = true;
      // Host fires first
      this.isMyTurn = this.rtc.isHost;
      this.updateTurnUI();
      this.dom.enemyGrid.classList.add('targeting');
      this.addCombatLog('info', `Combat initiated! ${this.isMyTurn ? 'You have priority fire!' : "Opponent fires first."}`);
      this.setIntel(this.isMyTurn ? "Target enemy coordinates on radar." : "Waiting for enemy artillery strike...");
    }
  }

  // Handling Player Targeting Fire
  handleRadarTargetClick(e) {
    if (!this.gameStarted || !this.isMyTurn || this.awaitingAttackResponse || this.gameOver) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const index = parseInt(cell.dataset.index, 10);

    // Prevent re-firing on already hit cells
    if (this.peerBoardHits[index] !== null) return;

    this.awaitingAttackResponse = true;
    window.soundEngine.playLaunch();
    this.createLaunchParticle(cell);

    const letter = String.fromCharCode(65 + Math.floor(index / 10));
    const num = (index % 10) + 1;
    this.addCombatLog('info', `Firing artillery at sector ${letter}-${num}...`);

    this.sendPacket({
      action: 'ATTACK',
      index
    });
  }

  // Incoming Attack from Peer (Defend & Reveal Proof)
  handleIncomingAttack(index) {
    const isShip = this.playerBoard[index] === 1;
    const proof = this.crypto.revealCellProof(index, this.playerBoard);

    // Update defense grid cell
    const cell = this.dom.playerGrid.querySelector(`[data-index="${index}"]`);
    let sunkShipName = null;

    if (isShip) {
      cell.classList.add('hit');
      window.soundEngine.playHit();
      this.createExplosionParticle(cell);

      // Track ship damage
      for (const ship of this.playerShipPlacements) {
        if (ship.coords.includes(index)) {
          ship.hits++;
          if (ship.hits >= ship.length && !ship.sunk) {
            ship.sunk = true;
            sunkShipName = ship.name;
            window.soundEngine.playSunk();
            this.updateFleetBadges('friendly', ship.id);
          }
          break;
        }
      }
    } else {
      cell.classList.add('miss');
      window.soundEngine.playMiss();
      this.createSplashParticle(cell);
    }

    // Check if player lost all ships
    const allSunk = this.playerShipPlacements.every(s => s.sunk);

    // Send back cryptographic proof and result
    this.sendPacket({
      action: 'ATTACK_RESULT',
      proof,
      sunkShipName,
      allSunk
    });

    const letter = String.fromCharCode(65 + Math.floor(index / 10));
    const num = (index % 10) + 1;
    this.addCombatLog(isShip ? 'hit' : 'miss', `Enemy artillery struck sector ${letter}-${num}: ${isShip ? 'DIRECT HIT!' : 'Splash (Miss)'}`);

    if (allSunk) {
      this.endGame(false);
    } else {
      this.isMyTurn = true;
      this.updateTurnUI();
      this.setIntel("Your turn! Designate enemy target sector.");
    }
  }

  // Result of our attack returned by peer
  async handleIncomingAttackResult(packet) {
    const { proof, sunkShipName, allSunk } = packet;
    this.awaitingAttackResponse = false;

    // Cryptographic validation of proof
    const verifyResult = await this.crypto.verifyPeerCell(proof);
    if (!verifyResult.valid) {
      alert("CHEAT ALERT: " + verifyResult.reason);
      this.addCombatLog('system', '[CRITICAL] Defense tampered with board commitment!');
      return;
    }

    const { index, isShip } = proof;
    this.peerBoardHits[index] = isShip ? 'hit' : 'miss';

    const cell = this.dom.enemyGrid.querySelector(`[data-index="${index}"]`);
    if (isShip) {
      cell.classList.add('hit');
      window.soundEngine.playHit();
      this.createExplosionParticle(cell);
      this.addCombatLog('hit', `Direct hit confirmed on target sector! [SHA-256 Verified]`);
    } else {
      cell.classList.add('miss');
      window.soundEngine.playMiss();
      this.createSplashParticle(cell);
      this.addCombatLog('miss', `Artillery missed target sector. [SHA-256 Verified]`);
    }

    if (sunkShipName) {
      this.addCombatLog('hit', `💥 Enemy ${sunkShipName.toUpperCase()} has been SUNK!`);
      window.soundEngine.playSunk();
      const def = FLEET_DEFINITIONS.find(s => s.name.toLowerCase() === sunkShipName.toLowerCase());
      if (def) this.updateFleetBadges('hostile', def.id);
    }

    if (allSunk) {
      this.endGame(true);
    } else {
      this.isMyTurn = false;
      this.updateTurnUI();
      this.setIntel("Artillery impact recorded. Awaiting enemy salvo...");
    }
  }

  updateFleetBadges(side, shipId) {
    const container = side === 'friendly' ? document.getElementById('friendly-fleet-status') : document.getElementById('hostile-fleet-status');
    const badge = container.querySelector(`[data-ship="${shipId}"]`);
    if (badge) {
      badge.classList.remove('active');
      badge.classList.add('sunk');
    }
  }

  updateTurnUI() {
    if (this.isMyTurn) {
      this.dom.turnIndicator.className = 'turn-indicator your-turn';
      this.dom.turnText.textContent = 'YOUR SALVO // DESIGNATE TARGET';
    } else {
      this.dom.turnIndicator.className = 'turn-indicator peer-turn';
      this.dom.turnText.textContent = "OPPONENT'S TURN // BRACE FOR IMPACT";
    }
  }

  endGame(isWinner) {
    this.gameOver = true;
    this.dom.gameOverModal.classList.remove('hidden');

    if (isWinner) {
      this.dom.gameOverTitle.textContent = '🏆 VICTORY ACHIEVED';
      this.dom.gameOverDesc.textContent = 'All hostile naval assets have been neutralized. Outstanding command!';
    } else {
      this.dom.gameOverTitle.textContent = '💀 DEFEAT ENCOUNTERED';
      this.dom.gameOverDesc.textContent = 'Your fleet has been dismantled by enemy fire. Better tactics next time!';
    }

    this.dom.auditLocalHash.textContent = this.crypto.localRootCommitment || 'N/A';
    this.dom.auditPeerHash.textContent = this.crypto.peerRootCommitment || 'N/A';
  }

  resetGame() {
    this.gameOver = false;
    this.gameStarted = false;
    this.peerReady = false;
    this.fleetLocked = false;
    this.peerBoardHits.fill(null);
    this.dom.dockPanel.style.display = 'flex';

    document.querySelectorAll('.ship-badge').forEach(b => {
      b.classList.remove('sunk');
      b.classList.add('active');
    });

    this.initGrids();
    this.randomizeFleet();
  }

  addCombatLog(type, message) {
    const entry = document.createElement('div');
    entry.className = `feed-entry ${type}`;
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.textContent = `[${time}] ${message}`;
    this.dom.combatFeed.appendChild(entry);
    this.dom.combatFeed.scrollTop = this.dom.combatFeed.scrollHeight;
  }

  setIntel(text) {
    this.dom.intelText.textContent = text;
  }

  // --- Camera QR Scanner Handlers ---

  async openCameraScanner(onSuccess) {
    this.dom.cameraModal.classList.remove('hidden');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      this.activeVideoStream = stream;
      this.dom.cameraVideo.srcObject = stream;
      this.dom.cameraVideo.setAttribute('playsinline', true);
      this.dom.cameraVideo.play();

      const canvas = this.dom.cameraCanvas;
      const ctx = canvas.getContext('2d');

      this.qrScanInterval = setInterval(() => {
        if (this.dom.cameraVideo.readyState === this.dom.cameraVideo.HAVE_ENOUGH_DATA) {
          canvas.height = this.dom.cameraVideo.videoHeight;
          canvas.width = this.dom.cameraVideo.videoWidth;
          ctx.drawImage(this.dom.cameraVideo, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });

          if (code && code.data) {
            this.closeCameraScanner();
            onSuccess(code.data);
          }
        }
      }, 200);
    } catch (err) {
      this.dom.cameraStatus.textContent = 'Camera permission denied or camera not found.';
    }
  }

  closeCameraScanner() {
    if (this.qrScanInterval) clearInterval(this.qrScanInterval);
    if (this.activeVideoStream) {
      this.activeVideoStream.getTracks().forEach(t => t.stop());
      this.activeVideoStream = null;
    }
    this.dom.cameraModal.classList.add('hidden');
  }

  // --- Particle FX Engine ---

  initCanvasFx() {
    const canvas = document.getElementById('fx-canvas');
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();

    const loop = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;

        if (p.life <= 0) {
          this.particles.splice(i, 1);
          continue;
        }

        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;
      requestAnimationFrame(loop);
    };
    loop();
  }

  createExplosionParticle(element) {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < 28; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 4 + 1.5;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: Math.random() * 3 + 1.5,
        color: Math.random() < 0.6 ? '#f43f5e' : '#e5b94c',
        life: 1.0,
        decay: Math.random() * 0.03 + 0.02
      });
    }
  }

  createSplashParticle(element) {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < 16; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 2 + 1;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: Math.random() * 2 + 1,
        color: '#38bdf8',
        life: 1.0,
        decay: Math.random() * 0.04 + 0.03
      });
    }
  }

  createLaunchParticle(element) {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < 10; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 10,
        y: cy + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        size: 2,
        color: '#e5b94c',
        life: 0.8,
        decay: 0.05
      });
    }
  }
}

// Boot game when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  window.aegisGame = new BattleshipGame();
});
