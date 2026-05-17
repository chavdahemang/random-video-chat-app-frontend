import React, { useRef, useEffect, useState, useCallback } from 'react';
import io from 'socket.io-client';
import './AzarPage.css';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://random-video-chat-app-ubkm.onrender.com';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const ts = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ─── Static icon components (no props that change each render) ─── */
const MicOnIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" /></svg>;
const MicOffIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" /></svg>;
const CamOnIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" /></svg>;
const CamOffIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" /></svg>;

/* ─── MsgList — defined OUTSIDE AzarPage so it never remounts ─── */
const MsgList = ({ messages, isConnected, endRef }) => (
  <>
    {messages.length === 0 && (
      <div className="azar-chat-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p>{isConnected ? 'Say hello! 👋' : 'Connect to start chatting'}</p>
      </div>
    )}
    {messages.map((m, i) => (
      <div key={i} className={`azar-msg ${m.type}`}>
        <div className="azar-msg-bubble">{m.text}</div>
        <div className="azar-msg-time">{m.time}</div>
      </div>
    ))}
    <div ref={endRef} />
  </>
);

/* ─── ChatInput — defined OUTSIDE AzarPage so it never remounts ─── */
const ChatInput = ({ draft, setDraft, onSubmit, isConnected }) => (
  <form onSubmit={onSubmit} className="azar-chat-form">
    <input
      type="text"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      placeholder={isConnected ? 'Type a message…' : 'Connect to chat…'}
      disabled={!isConnected}
    />
    <button className="azar-send-btn" type="submit" disabled={!isConnected || !draft.trim()}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
    </button>
  </form>
);

/* ─── Main component ─── */
export default function AzarPage() {
  const [socket, setSocket] = useState(null);
  const [myStream, setMyStream] = useState(null);
  const [partnerId, setPartnerId] = useState(null);
  const [isInitiator, setIsInitiator] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [messages, setMessages] = useState([]);   // never cleared
  const [draft, setDraft] = useState('');
  const [onlineUsers, setOnlineUsers] = useState(0);
  const [callDur, setCallDur] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const localVid = useRef();
  const remoteVid = useRef();
  const pipVid = useRef();
  const pcRef = useRef(null);
  const pendingRef = useRef([]);
  const socketRef = useRef(null);
  const timerRef = useRef();
  const hbRef = useRef();
  const msgEnd = useRef();

  const scrollBottom = useCallback(() => msgEnd.current?.scrollIntoView({ behavior: 'smooth' }), []);
  useEffect(() => { scrollBottom(); }, [messages, scrollBottom]);

  // process shim
  useEffect(() => {
    window.process = window.process || {};
    window.process.nextTick = window.process.nextTick || ((cb) => setTimeout(cb, 0));
  }, []);

  // Timer
  useEffect(() => {
    if (isConnected) {
      timerRef.current = setInterval(() => setCallDur(p => p + 1), 1000);
    } else {
      clearInterval(timerRef.current);
      setCallDur(0);
    }
    return () => clearInterval(timerRef.current);
  }, [isConnected]);

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // Get media
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user', width: { ideal: 1280 } } })
      .then(s => setMyStream(s))
      .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(s => setMyStream(s)).catch(console.error));
  }, []);

  // Attach local stream
  useEffect(() => {
    if (!myStream) return;
    [localVid, pipVid].forEach(r => {
      if (r.current) { r.current.srcObject = myStream; r.current.play().catch(() => { }); }
    });
  }, [myStream]);

  // Signal handler
  async function handleSignal(pc, sock, from, signal) {
    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sock.emit('signal', { to: from, signal: { type: 'answer', sdp: ans } });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        else pendingRef.current.push({ from, signal });
      }
    } catch (e) { console.error('[WebRTC]', signal.type, e.message); }
  }

  // Socket
  useEffect(() => {
    const sock = io(SOCKET_URL, {
      transports: ['websocket'], reconnection: true,
      secure: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, timeout: 20000,
    });
    socketRef.current = sock;
    setSocket(sock);

    sock.on('connect', () => {
      hbRef.current = setInterval(() => { if (sock.connected) sock.emit('heartbeat'); }, 25000);
    });
    sock.on('disconnect', () => clearInterval(hbRef.current));

    sock.on('waiting', () => { setIsWaiting(true); setIsConnected(false); });

    sock.on('paired', ({ partnerId: pid, initiator }) => {
      pendingRef.current = [];
      setPartnerId(pid); setIsInitiator(initiator);
      setIsWaiting(false); setIsConnected(true);
      setMessages(p => [...p, { type: 'system', text: '👋 Connected with a new stranger!', time: ts() }]);
    });

    sock.on('signal', async ({ from, signal }) => {
      const pc = pcRef.current;
      if (!pc) { pendingRef.current.push({ from, signal }); return; }
      await handleSignal(pc, sock, from, signal);
    });

    sock.on('chat-message', ({ message }) => {
      setMessages(p => [...p, { type: 'received', text: message, time: ts() }]);
      setUnread(p => p + 1);
    });

    sock.on('online-users', c => setOnlineUsers(c));

    sock.on('partner-left', () => {
      setMessages(p => [...p, { type: 'system', text: '👋 Stranger has left', time: ts() }]);
      setIsConnected(false); setPartnerId(null);
    });

    return () => { clearInterval(hbRef.current); sock.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Peer connection
  useEffect(() => {
    if (!isConnected || !myStream || !partnerId || !socket) return;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }

    const pc = new RTCPeerConnection({ iceTransportPolicy: 'all', iceCandidatePoolSize: 10, iceServers: ICE });
    pcRef.current = pc;

    // Drain pending
    (async () => {
      const buf = pendingRef.current.splice(0);
      for (const { from, signal } of buf) await handleSignal(pc, socket, from, signal);
    })();

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit('signal', { to: partnerId, signal: { type: 'candidate', candidate: e.candidate } });
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') skipPartner(); };
    pc.ontrack = e => {
      if (!e.streams?.[0]) return;
      if (remoteVid.current) { remoteVid.current.srcObject = e.streams[0]; remoteVid.current.play().catch(() => { }); }
    };

    myStream.getTracks().forEach(t => pc.addTrack(t, myStream));

    if (isInitiator) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: partnerId, signal: { type: 'offer', sdp: offer } });
        } catch (e) { console.error('[WebRTC] offer', e.message); }
      })();
    }
    return () => { if (pcRef.current) { pcRef.current.close(); pcRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, myStream, partnerId, socket, isInitiator]);

  const findPartner = () => {
    if (!socket) return;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (remoteVid.current) remoteVid.current.srcObject = null;
    pendingRef.current = [];
    setPartnerId(null); setIsConnected(false); setIsWaiting(true);
    socket.emit('find-partner');
  };

  const skipPartner = () => {
    if (!socket) return;
    setIsConnected(false);
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (remoteVid.current) remoteVid.current.srcObject = null;
    setPartnerId(null);
    socket.emit('skip');
    setIsWaiting(true);
  };

  const cancelWaiting = () => {
    if (!socket) return;
    socket.emit('skip');
    setIsWaiting(false);
    setIsConnected(false);
    setPartnerId(null);
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    pendingRef.current = [];
  };

  const toggleAudio = () => {
    myStream?.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setAudioOn(p => !p);
  };

  const toggleVideo = () => {
    myStream?.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setVideoOn(p => !p);
  };

  const sendMsg = useCallback((e) => {
    e.preventDefault();
    if (!draft.trim() || !socketRef.current || !partnerId) return;
    socketRef.current.emit('chat-message', { to: partnerId, message: draft });
    setMessages(p => [...p, { type: 'sent', text: draft, time: ts() }]);
    setDraft('');
  }, [draft, partnerId]);

  const openChat = () => { setChatOpen(true); setUnread(0); };

  return (
    <div className="azar-app">

      {/* NAV */}
      <nav className="azar-nav">
        <div className="azar-nav-logo">
          <div className="logo-dot" />
          <span style={{ background: 'linear-gradient(135deg,#00e5c4,#00bfa5)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>TalkCam</span>
        </div>
        <div className="azar-online-pill">
          <span className="azar-online-dot" />
          {onlineUsers} online
        </div>
        <div style={{ width: 80 }} />
      </nav>

      {/* CONTENT */}
      <div className="azar-content">

        {/* VIDEO STAGE */}
        <div className="azar-stage">

          {/* LOCAL card (desktop left) */}
          <div className="azar-local-card" style={{ display: myStream ? undefined : 'none' }}>
            <video ref={localVid} autoPlay muted playsInline className="azar-local-video" />
            <div className="azar-local-label">You</div>
            {/* pre-connect mic/cam on local card bottom */}
            {!isConnected && !isWaiting && myStream && (
              <div style={{ position: 'absolute', bottom: 12, right: 12, display: 'flex', gap: 8, zIndex: 10 }}>
                <button className={`azar-mini-ctrl ${!audioOn ? 'muted' : ''}`} onClick={toggleAudio} title={audioOn ? 'Mute' : 'Unmute'}>
                  {audioOn ? <MicOnIcon /> : <MicOffIcon />}
                </button>
                <button className={`azar-mini-ctrl ${!videoOn ? 'cam-off' : ''}`} onClick={toggleVideo} title={videoOn ? 'Camera off' : 'Camera on'}>
                  {videoOn ? <CamOnIcon /> : <CamOffIcon />}
                </button>
              </div>
            )}
          </div>

          {/* REMOTE card (desktop right) */}
          <div className="azar-remote-card">
            <video ref={remoteVid} autoPlay playsInline className="azar-remote-video" />

            {isConnected && (
              <div className="azar-call-badge">
                <span className="azar-call-status">Connected</span>
                <span className="azar-call-dur">{fmt(callDur)}</span>
              </div>
            )}

            {/* Searching overlay */}
            {isWaiting && (
              <div className="azar-remote-overlay">
                <div className="azar-waiting-ring"><div className="azar-spinner" /></div>
                <p className="azar-waiting-text">Looking for a stranger…</p>
                <button className="azar-cancel-btn" onClick={cancelWaiting}>Cancel</button>
              </div>
            )}

            {/* Start overlay */}
            {!isConnected && !isWaiting && (
              <div className="azar-remote-overlay">
                <div className="azar-start-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                </div>
                <h2>Meet Someone New</h2>
                <p>Tap Start to connect with a random stranger</p>
                <button className="azar-start-btn" onClick={findPartner} id="azar-start-btn">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  Start Now
                </button>
              </div>
            )}

            {/* Mobile chat toggle */}
            <button className="azar-mobile-chat-toggle" onClick={openChat} aria-label="Chat">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
            </button>
          </div>

          {/* PiP self on mobile */}
          <div className="azar-pip" style={{ display: myStream ? undefined : 'none' }}>
            <video ref={pipVid} autoPlay muted playsInline />
          </div>
        </div>

        {/* BOTTOM ACTION BAR */}
        <div className="azar-action-bar">
          {/* Left: End + Mic/Cam */}
          <div className="azar-action-left">
            {isConnected && (
              <button className="azar-end-btn" onClick={skipPartner} id="azar-end-btn">
                <span className="azar-end-key">ESC</span>
                <div className="azar-end-label">
                  <span>End</span>
                  <span>Press ESC to end the video chat</span>
                </div>
                {/* Mobile-only end icon */}
                <svg className="azar-end-mob-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                </svg>
              </button>
            )}
            {!isConnected && !isWaiting && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`azar-mini-ctrl ${!audioOn ? 'muted' : ''}`} onClick={toggleAudio}>{audioOn ? <MicOnIcon /> : <MicOffIcon />}</button>
                <button className={`azar-mini-ctrl ${!videoOn ? 'cam-off' : ''}`} onClick={toggleVideo}>{videoOn ? <CamOnIcon /> : <CamOffIcon />}</button>
              </div>
            )}
            {isConnected && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`azar-mini-ctrl ${!audioOn ? 'muted' : ''}`} onClick={toggleAudio}>{audioOn ? <MicOnIcon /> : <MicOffIcon />}</button>
                <button className={`azar-mini-ctrl ${!videoOn ? 'cam-off' : ''}`} onClick={toggleVideo}>{videoOn ? <CamOnIcon /> : <CamOffIcon />}</button>
                {/* Desktop chat float */}
                <button className="azar-chat-float" onClick={openChat} title="Chat">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
                </button>
              </div>
            )}
          </div>

          {/* Right: Next */}
          <div className="azar-action-right">
            {isConnected && (
              <button className="azar-next-btn" onClick={skipPartner} id="azar-next-btn">
                <div className="azar-next-label">
                  <span>Next</span>
                  <span>Press right key to meet others</span>
                </div>
                <div className="azar-next-arrow">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                </div>
              </button>
            )}
            {isWaiting && (
              <button className="azar-cancel-btn" onClick={cancelWaiting}>Cancel Search</button>
            )}
          </div>
        </div>
      </div>

      {/* CHAT DRAWER (desktop slide-in + mobile bottom sheet) */}
      <div className={`azar-chat-drawer ${chatOpen ? 'open' : ''}`}>
        <div style={{ width: 36, height: 4, background: 'rgba(255,255,255,0.15)', borderRadius: 2, margin: '10px auto 0', flexShrink: 0, cursor: 'pointer' }} onClick={() => setChatOpen(false)} />
        <div className="azar-drawer-header">
          <span>Live Chat</span>
          <button className="azar-drawer-close" onClick={() => setChatOpen(false)}>×</button>
        </div>
        <div className="azar-chat-msgs">
          <MsgList messages={messages} isConnected={isConnected} endRef={msgEnd} />
        </div>
        <div className="azar-chat-input-area">
          <ChatInput
            draft={draft}
            setDraft={setDraft}
            onSubmit={sendMsg}
            isConnected={isConnected}
          />
        </div>
      </div>
    </div>
  );
}
