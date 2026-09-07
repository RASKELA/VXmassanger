"use strict";

(function loadTransport() {
  const forcedRelay = new URLSearchParams(location.search).get("mode") === "relay";
  const supportsWebRtc = () => {
    const PeerConnection = globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection || globalThis.mozRTCPeerConnection;
    if (typeof PeerConnection !== "function") return false;
    try {
      const connection = new PeerConnection();
      connection.close();
      return true;
    } catch {
      return false;
    }
  };
  const mode = !forcedRelay && supportsWebRtc() ? "p2p" : "relay";
  document.documentElement.dataset.transport = mode;
  const script = document.createElement("script");
  script.src = mode === "p2p" ? "/p2p.js" : "/relay.js";
  script.defer = true;
  document.head.append(script);
})();
