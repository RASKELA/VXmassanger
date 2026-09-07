# VX — dual-mode messenger

[Русская версия](README.ru.md)

VX is a privacy-focused messenger that selects the best available transport in each browser.

## Two modes, one address

| Mode | When it is selected | Authentication and storage |
| --- | --- | --- |
| **P2P** | The browser can create a WebRTC `RTCPeerConnection`. | No account. Contacts and message history remain in the browser; messages use an encrypted WebRTC DataChannel. |
| **Relay** | WebRTC is unavailable or disabled, such as in a standard Tor Browser configuration. | Sign in with a six-digit e-mail code. Users, chats, and message history are stored on the VX server. |

The choice is based on the actual WebRTC capability, not the browser name. Firefox with a Tor extension can therefore use P2P when WebRTC is enabled. A browser that blocks WebRTC receives the relay client automatically.

To use the relay messenger deliberately, append `?mode=relay` to the VX address.

> **Privacy note:** relay mode is a conventional server-hosted messenger and is not end-to-end encrypted. Use P2P mode when you need direct peer-to-peer transport.

## Quick start

Requirements: Node.js 20 or newer. For relay e-mail sign-in, an SMTP account is also required.

```powershell
Copy-Item .env.example .env
npm start
```

Open `http://127.0.0.1:3000` in a browser. The browser chooses P2P or relay mode automatically.

## Configuration

Copy `.env.example` to `.env` and set the values needed by your deployment. `.env` is ignored by Git and must never be committed.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Local VX listener. Keep `HOST=127.0.0.1` when publishing through Tor. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP connection used to deliver relay sign-in codes. |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mailbox credentials and sender. Gmail requires an App Password, not the main account password. |
| `DEV_SHOW_OTP` | Leave `false` outside an isolated development machine; otherwise a code could be returned in a browser response. |
| `ICE_SERVERS` | Optional STUN/TURN configuration for P2P peers across NAT. A TURN service you control is recommended for production. |
| `TOR_ONLY` | Keeps optional relay-mode WebRTC call controls hidden. It does not disable the standalone P2P client. |

## Tor onion service

The VX server listens only on loopback. Point a Tor hidden service at it:

```torrc
HiddenServiceDir /var/lib/tor/vx_service
HiddenServicePort 80 127.0.0.1:3000
```

Restart Tor, then read the generated `hostname` file inside `HiddenServiceDir` to obtain the `.onion` address. Open that address with `http://` in Tor Browser. The browser will use relay mode when WebRTC is unavailable.

## Security checklist

- Do not share or commit SMTP App Passwords. If one was sent in a chat, revoke it and create a replacement.
- Keep `.env`, `tor/torrc.local`, Tor runtime data, and hidden-service keys private.
- Use HTTPS on clearnet deployments and a private TURN service for P2P connections across NAT.
- Keep Node.js, Tor, and the operating system updated.

## Verification

```powershell
npm run check
```

This checks the server, transport loader, P2P client, and relay client for JavaScript syntax errors.
