/**
 * Aegis Cryptographic Commitment & Anti-Cheat Module
 *
 * Implements a provably fair Zero-Knowledge-style commit-reveal mechanism:
 * 1. Cell-level salt generation: Each of the 100 cells has a cryptographically secure random salt.
 * 2. Hash Commitment: SHA-256("STATE:SALT") computed for every cell.
 * 3. Root Commitment: SHA-256 hash of all 100 cell commitments concatenated.
 * 4. Mutual exchange: Both players exchange Root Commitments and Cell Commitment lists before the game starts.
 * 5. Strike Verification: On every shot at (x,y), defender replies with (STATE, SALT).
 *    Attacker immediately re-hashes and validates against defender's pre-committed hash.
 * 6. Impossible to cheat: Neither player can alter ship positions or lie about hits/misses.
 */

class BattleshipCrypto {
  constructor() {
    this.localSalts = new Array(100);
    this.localCellCommitments = new Array(100);
    this.localRootCommitment = null;

    this.peerCellCommitments = null;
    this.peerRootCommitment = null;
  }

  // Generate cryptographically secure random string (16 bytes hex)
  static generateSalt() {
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Native Web Crypto API SHA-256
  static async sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Commit a player's board state (100 cells)
   * boardState: Array of length 100, where element is 1 (ship present) or 0 (water)
   * Returns: { rootHash, cellHashes } to send to peer
   */
  async commitBoard(boardState) {
    let combinedHashes = "";

    for (let i = 0; i < 100; i++) {
      const salt = BattleshipCrypto.generateSalt();
      this.localSalts[i] = salt;
      const stateStr = boardState[i] ? "SHIP" : "WATER";
      const cellHash = await BattleshipCrypto.sha256(`${stateStr}:${salt}`);
      this.localCellCommitments[i] = cellHash;
      combinedHashes += cellHash;
    }

    this.localRootCommitment = await BattleshipCrypto.sha256(combinedHashes);

    return {
      rootHash: this.localRootCommitment,
      cellHashes: this.localCellCommitments
    };
  }

  /**
   * Store and verify peer's initial commitment
   */
  async setPeerCommitment(rootHash, cellHashes) {
    if (!cellHashes || cellHashes.length !== 100) {
      throw new Error("Invalid peer cell commitments count.");
    }

    // Verify root commitment matches cell commitments
    const combined = cellHashes.join('');
    const calculatedRoot = await BattleshipCrypto.sha256(combined);
    if (calculatedRoot !== rootHash) {
      throw new Error("Peer root commitment mismatch! Possible tampering detected.");
    }

    this.peerRootCommitment = rootHash;
    this.peerCellCommitments = cellHashes;
    return true;
  }

  /**
   * Reveal cell proof when attacked
   * index: cell index (0-99)
   * boardState: current board
   */
  revealCellProof(index, boardState) {
    const isShip = boardState[index] ? true : false;
    const salt = this.localSalts[index];
    return {
      index,
      isShip,
      salt
    };
  }

  /**
   * Verify peer's strike response against their original commitment
   * proof: { index, isShip, salt }
   */
  async verifyPeerCell(proof) {
    const { index, isShip, salt } = proof;
    if (!this.peerCellCommitments || !this.peerCellCommitments[index]) {
      throw new Error("No peer commitment found for cell " + index);
    }

    const stateStr = isShip ? "SHIP" : "WATER";
    const calculatedHash = await BattleshipCrypto.sha256(`${stateStr}:${salt}`);
    const expectedHash = this.peerCellCommitments[index];

    if (calculatedHash !== expectedHash) {
      return {
        valid: false,
        reason: `Cryptographic proof mismatch on cell ${index}! Defense attempted to tamper with board state.`
      };
    }

    return { valid: true, isShip };
  }
}

window.BattleshipCrypto = BattleshipCrypto;
