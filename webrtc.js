/**
 * Aegis WebRTC Peer-to-Peer Zero-Server Engine
 * Supports compact base64-deflated signaling for easy copy-paste & instant QR generation.
 */

class WebRTCEngine {
  constructor(options = {}) {
    this.peerConnection = null;
    this.dataChannel = null;
    this.isHost = false;

    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});

    // Free public Google STUN configuration
    this.config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  // Helper: deflate + base64 compression for tiny QR codes and short shareable strings
  static async compressPayload(obj) {
    const jsonStr = JSON.stringify(obj);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const stream = blob.stream().pipeThrough(new CompressionStream('deflate'));
    const compressedResponse = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(compressedResponse);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Helper: base64 + inflate decompression
  static async decompressPayload(base64Str) {
    const binary = atob(base64Str.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes]);
    const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
    const decompressed = await new Response(stream).text();
    return JSON.parse(decompressed);
  }

  // Wait for ICE gathering to complete so all candidates are bundled into one string
  waitForIceGathering() {
    return new Promise(resolve => {
      if (this.peerConnection.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (this.peerConnection.iceGatheringState === 'complete') {
            this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        this.peerConnection.addEventListener('icegatheringstatechange', checkState);
      }
    });
  }

  // Initialize Host: Create Offer & Setup Data Channel
  async initHost() {
    this.isHost = true;
    this.peerConnection = new RTCPeerConnection(this.config);

    // Create reliable, ordered data channel
    this.dataChannel = this.peerConnection.createDataChannel('aegis-battleship', {
      ordered: true
    });
    this.bindDataChannel(this.dataChannel);

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    // Wait until full ICE gathering completes
    await this.waitForIceGathering();

    // Compress offer into short code
    const payload = {
      type: 'offer',
      sdp: this.peerConnection.localDescription.sdp
    };
    return await WebRTCEngine.compressPayload(payload);
  }

  // Host: Accept Opponent's Answer
  async acceptAnswer(answerCode) {
    try {
      const payload = await WebRTCEngine.decompressPayload(answerCode);
      if (payload.type !== 'answer') {
        throw new Error("Invalid payload type. Expected 'answer'.");
      }
      const desc = new RTCSessionDescription({ type: 'answer', sdp: payload.sdp });
      await this.peerConnection.setRemoteDescription(desc);
      return true;
    } catch (err) {
      this.onError("Failed to accept answer: " + err.message);
      throw err;
    }
  }

  // Initialize Joiner: Accept Host's Offer & Generate Answer
  async initJoiner(offerCode) {
    this.isHost = false;
    this.peerConnection = new RTCPeerConnection(this.config);

    // Listen for incoming data channel
    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.bindDataChannel(this.dataChannel);
    };

    const payload = await WebRTCEngine.decompressPayload(offerCode);
    if (payload.type !== 'offer') {
      throw new Error("Invalid payload type. Expected 'offer'.");
    }

    const offerDesc = new RTCSessionDescription({ type: 'offer', sdp: payload.sdp });
    await this.peerConnection.setRemoteDescription(offerDesc);

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    // Wait for ICE gathering
    await this.waitForIceGathering();

    const answerPayload = {
      type: 'answer',
      sdp: this.peerConnection.localDescription.sdp
    };
    return await WebRTCEngine.compressPayload(answerPayload);
  }

  bindDataChannel(dc) {
    dc.onopen = () => {
      this.onStateChange('connected');
    };

    dc.onclose = () => {
      this.onStateChange('disconnected');
    };

    dc.onerror = (err) => {
      this.onError("Data Channel error: " + (err.message || "Unknown"));
    };

    dc.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.onMessage(message);
      } catch (err) {
        console.error("Malformed message received:", event.data);
      }
    };
  }

  // Send JSON packet directly over P2P Data Channel (zero latency)
  send(packet) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(packet));
      return true;
    } else {
      console.warn("Attempted to send over closed channel", packet);
      return false;
    }
  }

  close() {
    if (this.dataChannel) this.dataChannel.close();
    if (this.peerConnection) this.peerConnection.close();
  }
}

window.WebRTCEngine = WebRTCEngine;
