import React, { useRef, useEffect, useState } from 'react';
import io from 'socket.io-client';
import "./App.css"

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'https://video-chat-backend.onrender.com';

function App() {
  console.log("backend url",SOCKET_SERVER_URL)
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

  const myVideo = useRef();
  const partnerVideo = useRef();
  const pcRef = useRef(null);
  const messagesEndRef = useRef();
  const timerRef = useRef();
  const isMounted = useRef(true); // Add this line


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

  // Get user media
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        console.log('Got local stream');
        setMyStream(stream);
        if (myVideo.current) {
          myVideo.current.srcObject = stream;
        }
      })
      .catch(err => console.error('Media error:', err));
  }, []);

  // Socket connection
  useEffect(() => {
    isMounted.current = true; // Add this at the beginning
    const newSocket = io(SOCKET_SERVER_URL);
    setSocket(newSocket);

    newSocket.on('waiting', () => {
      console.log('Waiting for partner...');
      setIsWaiting(true);
      setIsConnected(false);
    });

    newSocket.on('paired', ({ partnerId, initiator }) => {
      console.log('Paired with:', partnerId, 'Initiator:', initiator);
      setPartnerId(partnerId);
      setIsInitiator(initiator);
      setIsWaiting(false);
      setIsConnected(true);
      // Add system message
      setMessages(prev => [...prev, {
        type: 'system',
        text: 'Connected with a new partner!',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    });

    newSocket.on('signal', async ({ from, signal }) => {

      const pc = pcRef.current;
      if (!pc) return;

      try {

        if (signal.type === "offer") {

          await pc.setRemoteDescription(
            new RTCSessionDescription(signal.sdp)
          );

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          newSocket.emit("signal", {
            to: from,
            signal: {
              type: "answer",
              sdp: answer
            }
          });

        }

        else if (signal.type === "answer") {

          await pc.setRemoteDescription(
            new RTCSessionDescription(signal.sdp)
          );

        }

        else if (signal.type === "candidate") {

          await pc.addIceCandidate(
            new RTCIceCandidate(signal.candidate)
          );

        }

      } catch (err) {
        console.log("Signal error:", err);
      }

    });

    // Add chat message listener
    newSocket.on('chat-message', ({ from, message }) => {
      setMessages(prev => [...prev, {
        type: 'received',
        text: message,
        from: 'Partner',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    });

    newSocket.on("online-users", (count) => {
      setOnlineUsers(count);
    });

    newSocket.on('partner-left', () => {
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
      newSocket.disconnect();
    };
  }, []);

  // Create peer connection
  useEffect(() => {

    if (!isConnected || !myStream || !partnerId || !socket || pcRef.current) return;

    console.log("Creating RTCPeerConnection");

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ]
    });

    pcRef.current = pc;

    // send ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {

        socket.emit("signal", {
          to: partnerId,
          signal: {
            type: "candidate",
            candidate: event.candidate
          }
        });

      }
    };

    // receive remote stream
    pc.ontrack = (event) => {
      console.log("Remote stream received");

      if (partnerVideo.current) {
        partnerVideo.current.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
  if (pc.connectionState === "failed") {
    skipPartner();
  }
};

    // add local tracks
    myStream.getTracks().forEach(track => {
      pc.addTrack(track, myStream);
    });

    // if initiator → create offer
    if (isInitiator) {

      (async () => {

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("signal", {
          to: partnerId,
          signal: {
            type: "offer",
            sdp: offer
          }
        });

      })();

    }

    return () => {

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

    };

  }, [isConnected, myStream, partnerId, socket, isInitiator]);

  const findPartner = () => {
    if (socket) {
      // Clean up existing connection
      // if (peerRef.current) {
      //   try {
      //     peerRef.current.removeAllListeners?.();
      //     peerRef.current.destroy();
      //   } catch (err) {
      //     console.error('Error destroying peer:', err);
      //   }
      //   peerRef.current = null;
      // }

      if (partnerVideo.current) {
        partnerVideo.current.srcObject = null;
      }

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

      <header className="header">
        <div className="logo-container">
          <span className="logo-text">VideoChat</span>
        </div>
        <div className="header-right">
          <span className="online-badge">
            <span className="online-dot"></span>
            {onlineUsers} online
          </span>
        </div>
      </header>

      <div className="main-content">
        {/* Video Section */}
        <div className={`video-section ${isSidebarOpen ? 'with-sidebar' : ''}`}>
          {/* Partner Video (Big) */}
          <div className="partner-video-container">
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
                <div className="spinner"></div>
                <p>Looking for a partner...</p>
                <button className="cancel-btn" onClick={cancelWaiting}>Cancel</button>
              </div>
            )}

            {/* Start Overlay */}
            {!isConnected && !isWaiting && (
              <div className="start-overlay">
                <h2>Ready to meet someone new?</h2>
                <button className="start-btn" onClick={findPartner}>
                  Start Video Chat
                </button>
              </div>
            )}

            {/* Self Video (Small) */}
            {myStream && (
              <div className="self-video-container">
                <video
                  ref={myVideo}
                  autoPlay
                  muted
                  playsInline
                  className="self-video"
                />
              </div>
            )}
          </div>

          {/* Bottom Controls */}
          {/* Bottom Controls */}
          {isConnected && (
            <div className="bottom-controls">
              <button className="control-btn end" onClick={skipPartner}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13.5v-7l6 3.5-6 3.5z" />
                </svg>
                End
              </button>

              <button
                className={`control-btn ${!isAudioEnabled ? 'active' : ''}`}
                onClick={toggleAudio}
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

        {/* Chat Sidebar */}
        <div className={`chat-sidebar ${isSidebarOpen ? 'open' : ''}`}>
          <div className="chat-header">
            <h3>Group Chat</h3>
            <span className="participant-count">{messages.length} messages</span>
          </div>

          <div className="chat-messages">
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
                placeholder="Type a message..."
                disabled={!isConnected}
              />
              <button type="submit" disabled={!isConnected || !newMessage.trim()}>
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;