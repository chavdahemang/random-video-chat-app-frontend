import React, { useRef, useEffect, useState } from 'react';
import io from 'socket.io-client';
import "./App.css"

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'https://video-chat-backend.onrender.com';

function App() {
  console.log("backend urls",SOCKET_SERVER_URL)
  const [socket, setSocket] = useState(null);
  const [myStream, setMyStream] = useState(null);
  const [partnerId, setPartnerId] = useState(null);
  const [isInitiator, setIsInitiator] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [onlineUsers, setOnlineUsers] = useState(0);
  const [callDuration, setCallDuration] = useState(0);
  const [remoteStream, setRemoteStream] = useState(null);

  const myVideo = useRef();
  const partnerVideo = useRef();
  const pcRef = useRef(null);
  const messagesEndRef = useRef();
  const timerRef = useRef();
  const heartbeatRef = useRef(null);
  const isMounted = useRef(true);
  // Buffer for ICE candidates / signals that arrive before RTCPeerConnection is ready
  const pendingSignalsRef = useRef([]);
  const socketRef = useRef(null);


  // Scroll to bottom of chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Source - https://stackoverflow.com/a/71331099
  // Posted by Nagibaba
  // Retrieved 2026-03-07, License - CC BY-SA 4.0

  useEffect(() => {
    window.process = window.process || {};
    window.process.nextTick = window.process.nextTick || function (callback) {
      setTimeout(callback, 0);
    };

  }, []);


  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Call timer
  useEffect(() => {
    if (isConnected) {
      timerRef.current = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
      setCallDuration(0);
    }
    return () => clearInterval(timerRef.current);
  }, [isConnected]);

  // Format time
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Get user media - request camera/mic on load
  useEffect(() => {
    const constraints = {
      audio: true,
      video: {
        // prefer front camera on mobile, any camera on desktop
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => {
        console.log('Got local stream');
        setMyStream(stream);
      })
      .catch(err => {
        console.error('Media error:', err);
        // On mobile the first attempt may fail if facing mode is unsupported;
        // fall back to any available camera
        navigator.mediaDevices.getUserMedia({ video: true, audio: true })
          .then(stream => setMyStream(stream))
          .catch(err2 => console.error('Media fallback error:', err2));
      });
  }, []);

  // Attach local stream to video element whenever either is ready
  // This fixes the camera preview not showing on mobile where the ref
  // may not be mounted yet when the stream first arrives
  useEffect(() => {
    if (myStream && myVideo.current) {
      myVideo.current.srcObject = myStream;
      // iOS Safari requires explicit play() call even with autoPlay attribute
      myVideo.current.play().catch(() => {});
    }
  }, [myStream]);

  // Attach remote stream to partner video element
  useEffect(() => {
    if (remoteStream && partnerVideo.current) {
      partnerVideo.current.srcObject = remoteStream;
      // iOS Safari requires explicit play() after setting srcObject
      partnerVideo.current.play().catch(() => {});
    }
  }, [remoteStream]);

  // Socket connection
  useEffect(() => {
    isMounted.current = true;

    const newSocket = io(SOCKET_SERVER_URL, {
      // polling first → always works even on mobile carrier NAT / strict firewalls
      // Socket.IO auto-upgrades to WebSocket once polling succeeds
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('[Socket] Connected:', newSocket.id);
      heartbeatRef.current = setInterval(() => {
        if (newSocket.connected) newSocket.emit('heartbeat');
      }, 25000);
    });

    newSocket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      clearInterval(heartbeatRef.current);
    });

    newSocket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message);
    });

    newSocket.on('waiting', () => {
      console.log('[Socket] Waiting for partner...');
      setIsWaiting(true);
      setIsConnected(false);
    });

    newSocket.on('paired', ({ partnerId, initiator }) => {
      console.log('[Socket] Paired with:', partnerId, '| Initiator:', initiator);
      // Clear any buffered signals from previous session
      pendingSignalsRef.current = [];
      setPartnerId(partnerId);
      setIsInitiator(initiator);
      setIsWaiting(false);
      setIsConnected(true);
      setMessages(prev => [...prev, {
        type: 'system',
        text: 'Connected with a new partner!',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    });

    // CRITICAL FIX: signals (especially offers) often arrive BEFORE the
    // RTCPeerConnection is created because React state updates are async.
    // We buffer them here and drain the queue once the PC is ready.
    newSocket.on('signal', async ({ from, signal }) => {
      const pc = pcRef.current;

      if (!pc) {
        // PC not ready yet — buffer the signal
        console.log('[Signal] PC not ready, buffering signal type:', signal.type);
        pendingSignalsRef.current.push({ from, signal });
        return;
      }

      await handleSignal(pc, newSocket, from, signal);
    });

    newSocket.on('chat-message', ({ from, message }) => {
      setMessages(prev => [...prev, {
        type: 'received',
        text: message,
        from: 'Partner',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    });

    newSocket.on('online-users', (count) => {
      setOnlineUsers(count);
    });

    newSocket.on('partner-left', () => {
      console.log('[Socket] Partner left');
      setMessages(prev => [...prev, {
        type: 'system',
        text: 'Partner disconnected',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
      setIsConnected(false);
      setPartnerId(null);
    });

    return () => {
      isMounted.current = false;
      clearInterval(heartbeatRef.current);
      newSocket.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper: process a single signal on a given RTCPeerConnection
  async function handleSignal(pc, sock, from, signal) {
    try {
      if (signal.type === 'offer') {
        console.log('[WebRTC] Received offer, creating answer');
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sock.emit('signal', { to: from, signal: { type: 'answer', sdp: answer } });

      } else if (signal.type === 'answer') {
        console.log('[WebRTC] Received answer');
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      } else if (signal.type === 'candidate') {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          // Remote description not set yet — buffer the candidate too
          pendingSignalsRef.current.push({ from, signal });
        }
      }
    } catch (err) {
      console.error('[WebRTC] Signal error:', signal.type, err.message);
    }
  }

  // Create peer connection whenever we get paired
  useEffect(() => {
    if (!isConnected || !myStream || !partnerId || !socket) return;

    // CRITICAL FIX: always close/null the old PC before creating a new one.
    // Without this, the guard below would block new sessions after skip/reconnect.
    if (pcRef.current) {
      console.log('[WebRTC] Closing stale RTCPeerConnection before creating new one');
      pcRef.current.close();
      pcRef.current = null;
    }

    console.log('[WebRTC] Creating RTCPeerConnection');

    const pc = new RTCPeerConnection({
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 10,
      iceServers: [
        // Google public STUN
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        // Cloudflare STUN (very fast, globally distributed)
        { urls: 'stun:stun.cloudflare.com:3478' },
        // Open Relay TURN — required for mobile carrier NAT (CGNAT)
        // These free credentials are published by the Open Relay Project
        { urls: 'turn:openrelay.metered.ca:80',       username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443',      username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    });

    pcRef.current = pc;

    // Drain any buffered signals that arrived before the PC was ready
    const drainPending = async () => {
      const buffered = pendingSignalsRef.current.splice(0);
      console.log('[WebRTC] Draining', buffered.length, 'buffered signals');
      for (const { from, signal } of buffered) {
        await handleSignal(pc, socket, from, signal);
      }
    };
    drainPending();

    // ICE candidate → send to partner via socket
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', { to: partnerId, signal: { type: 'candidate', candidate: event.candidate } });
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log('[ICE] Gathering state:', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ICE] Connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn('[ICE] Failed — attempting ICE restart');
        pc.restartIce();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'failed') {
        skipPartner();
      }
    };

    // Remote stream received → display partner video
    pc.ontrack = (event) => {
      console.log('[WebRTC] Remote track received', event.streams);
      if (!event.streams || !event.streams[0]) return;
      setRemoteStream(event.streams[0]);
      if (partnerVideo.current) {
        partnerVideo.current.srcObject = event.streams[0];
        partnerVideo.current.play().catch(() => {});
      }
    };

    // Add our local tracks to the connection
    myStream.getTracks().forEach(track => pc.addTrack(track, myStream));

    // Initiator creates and sends the offer
    if (isInitiator) {
      (async () => {
        try {
          console.log('[WebRTC] Creating offer as initiator');
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: partnerId, signal: { type: 'offer', sdp: offer } });
        } catch (err) {
          console.error('[WebRTC] Offer creation failed:', err.message);
        }
      })();
    }

    return () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, myStream, partnerId, socket, isInitiator]);

  const findPartner = () => {
    if (socket) {
      // CRITICAL FIX: explicitly close and clear the old peer connection here.
      // The useEffect guard `if (pcRef.current) return` would otherwise block
      // a new connection from being created on the next pair.
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (partnerVideo.current) {
        partnerVideo.current.srcObject = null;
      }
      pendingSignalsRef.current = [];
      setRemoteStream(null);
      setPartnerId(null);
      setIsConnected(false);
      setIsWaiting(true);
      setMessages([]);
      socket.emit('find-partner');
    }
  };

  const skipPartner = () => {
    if (socket) {
      // First set connected to false to prevent any new operations
      setIsConnected(false);

      // Then destroy peer
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

      // Clear partner video
      if (partnerVideo.current) {
        partnerVideo.current.srcObject = null;
      }

      // Reset states
      setPartnerId(null);
      setMessages([]);

      // Emit skip event
      socket.emit('skip');
      setIsWaiting(true);
    }
  };

  const toggleAudio = () => {
    if (myStream) {
      myStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsAudioEnabled(!isAudioEnabled);
    }
  };

  const toggleVideo = () => {
    if (myStream) {
      myStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsVideoEnabled(!isVideoEnabled);
    }
  };

  const sendMessage = (e) => {
    e.preventDefault();

    if (newMessage.trim() && socket && partnerId) {
      const messageData = {
        text: newMessage,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      socket.emit('chat-message', {
        to: partnerId,
        message: newMessage
      });

      setMessages(prev => [
        ...prev,
        { type: 'sent', ...messageData, from: 'You' }
      ]);

      setNewMessage('');
    }
  };
const cancelWaiting = () => {

  if (socket) {
    socket.emit("skip"); // server will detect waiting state
    setIsWaiting(false);
  }

};
  return (
    <div className="app-container">
      <div className="background"></div>

      {/* ===== HEADER ===== */}
      <header className="header">
        <div className="logo-container">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
          <span className="logo-text">RandomChat</span>
        </div>
        <div className="header-right">
          <span className="online-badge">
            <span className="online-dot"></span>
            {onlineUsers} online
          </span>
        </div>
      </header>

      <div className="main-content">
        {/* ===== VIDEO SECTION ===== */}
        <div className={`video-section ${isSidebarOpen ? 'with-sidebar' : ''}`}>
          <div className="partner-video-container">

            {/* Partner Video */}
            <video
              ref={partnerVideo}
              autoPlay
              playsInline
              className="partner-video"
            />

            {/* Call Info Overlay */}
            {isConnected && (
              <div className="call-info">
                <span className="call-status">Connected</span>
                <span className="call-duration">{formatTime(callDuration)}</span>
              </div>
            )}

            {/* Waiting Overlay */}
            {isWaiting && (
              <div className="waiting-overlay">
                <div className="pulse-rings">
                  <div className="spinner"></div>
                </div>
                <p>Looking for a partner...</p>
                <button className="cancel-btn" onClick={cancelWaiting}>Cancel</button>
              </div>
            )}

            {/* Start Overlay */}
            {!isConnected && !isWaiting && (
              <div className="start-overlay">
                <div className="start-overlay-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                </div>
                <h2>Meet Someone New</h2>
                <p>Connect instantly with a random person for a video chat</p>
                <button className="start-btn" onClick={findPartner}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Start Video Chat
                </button>
              </div>
            )}

            {/* Self Video PiP — always rendered so ref is available */}
            <div className="self-video-container" style={{ display: myStream ? 'block' : 'none' }}>
              <video
                ref={myVideo}
                autoPlay
                muted
                playsInline
                className="self-video"
              />
            </div>

            {/* ===== BOTTOM CONTROLS (when connected) ===== */}
            {isConnected && (
              <div className="bottom-controls">
                <button className="control-btn end" onClick={skipPartner}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                  </svg>
                  Skip
                </button>

                <div className="control-divider"></div>

                <button
                  className={`control-btn ${!isAudioEnabled ? 'active' : ''}`}
                  onClick={toggleAudio}
                  title={isAudioEnabled ? 'Mute mic' : 'Unmute mic'}
                >
                  {isAudioEnabled ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  )}
                </button>

                <button
                  className={`control-btn ${!isVideoEnabled ? 'active' : ''}`}
                  onClick={toggleVideo}
                  title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
                >
                  {isVideoEnabled ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
                    </svg>
                  )}
                </button>
              </div>
            )}

            {/* ===== PRE-CONNECTION CONTROLS (mic/cam always accessible) ===== */}
            {!isConnected && !isWaiting && myStream && (
              <div className="preconnect-controls">
                <button
                  className={`control-btn ${!isAudioEnabled ? 'active' : ''}`}
                  onClick={toggleAudio}
                  title={isAudioEnabled ? 'Mute mic' : 'Unmute mic'}
                >
                  {isAudioEnabled ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  )}
                </button>
                <button
                  className={`control-btn ${!isVideoEnabled ? 'active' : ''}`}
                  onClick={toggleVideo}
                  title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
                >
                  {isVideoEnabled ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
                    </svg>
                  )}
                </button>
              </div>
            )}

          </div>
        </div>

        {/* ===== CHAT SIDEBAR ===== */}
        <div className={`chat-sidebar ${isSidebarOpen ? 'open' : ''}`}>
          <div className="chat-header">
            <div className="chat-header-title">
              <div className="chat-header-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h3>Live Chat</h3>
            </div>
            <span className="participant-count">{messages.length} msgs</span>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p>{isConnected ? 'Say hi to your partner!' : 'Connect with someone to start chatting'}</p>
              </div>
            )}
            {messages.map((msg, index) => (
              <div key={index} className={`message ${msg.type}`}>
                {msg.type !== 'system' && (
                  <div className="message-sender">{msg.from}</div>
                )}
                <div className="message-content">{msg.text}</div>
                <div className="message-time">{msg.time}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-container">
            <form onSubmit={sendMessage} className="chat-input-form">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={isConnected ? 'Type a message...' : 'Connect to chat...'}
                disabled={!isConnected}
              />
              <button className="send-btn" type="submit" disabled={!isConnected || !newMessage.trim()}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;