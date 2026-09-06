# VX messenger

VX is a self-hosted web messenger with e-mail one-time-code sign-in, image messages, direct and group conversations, profiles, reactions, message editing/deletion, read indicators and browser voice/video calls. It has no external JavaScript dependencies: Node.js 20+ is enough.

## Tor address for users

Open the shared VX service in Tor Browser: [http://slti2hfwjwzoxnb3zabqvllq75zqozrmq7irxq6jt425xtzafdatchyd.onion/](http://slti2hfwjwzoxnb3zabqvllq75zqozrmq7irxq6jt425xtzafdatchyd.onion/)

127.0.0.1:3000 is only for the host computer running VX. Other users should use the onion address above; it remains available while that host's VX and Tor processes are running.

## Included features

- Passwordless registration and sign-in by e-mail OTP.
- Live in-browser updates with Server-Sent Events, with a resilient polling fallback.
- Direct chats and owner-managed group channels, including registered-contact search when creating a group.
- A copyable invitation containing the current VX server address, so friends can join the same server before being added to chats or groups.
- Image uploads (PNG, JPEG, GIF and WebP, maximum 5 MB), reactions, replies, edits, deletion, typing indicators and unread counters.
- Creator-owned sticker packs: upload a first sticker to create a pack, add up to 120 stickers, install available packs and send stickers in conversations.
- Display name, bio and optional profile image.
- Optional one-to-one voice/video calls with WebRTC and browser-standard DTLS-SRTP/ECDH key negotiation when `TOR_ONLY=false`.

## Start locally

1. Copy `.env.example` to `.env` and configure SMTP. Keep `.env` private: it is excluded from Git.
2. Leave `TOR_ONLY=true`. This disables browser calls, whose media traffic cannot reliably be kept inside Tor.
3. Run `node server.js` in this folder.
4. On the host computer only, open `http://127.0.0.1:3000`. All other users open the Tor address above in Tor Browser.
Without SMTP, local development still works: by default the one-time code is displayed in the browser response. Set `DEV_SHOW_OTP=false` before exposing the service.

## Tor-only mode

VX always listens on loopback (`127.0.0.1`, or `::1` if explicitly selected); it will not bind a public network interface. Publish it exclusively through the onion service shown in `tor/torrc.example`.

`TOR_ONLY=true` is the default and disables browser WebRTC calls. That is intentional: normal browser WebRTC can create direct or TURN media paths that are not guaranteed to use Tor, even when signalling is reached through an onion address. If you deliberately set `TOR_ONLY=false`, the existing calls use WebRTC DTLS-SRTP with ECDH key agreement, but you must accept and assess that network-identity risk.

The requested Gmail SMTP account is an external e-mail provider, not an onion service. If SMTP traffic must also be Tor-routed, point `SMTP_HOST` to a local SMTP relay that your operating system routes through Tor; do not claim Gmail SMTP alone is Tor-only.

## Security model

- Authentication is passwordless: only a short-lived, hashed OTP is stored. Browser sessions are random bearer tokens held in memory, expire after seven days, and disappear when the server restarts.
- Text and attachment metadata are stored in `data/store.json`; uploads are stored under `public/uploads`. Protect this directory with filesystem encryption/backups appropriate to the deployment.
- Calls use the browser's WebRTC stack. WebRTC negotiates DTLS-SRTP session keys with ECDH; VX does not implement unsafe home-grown call cryptography. For production calls, configure a TURN service you control in `ICE_SERVERS`, serve VX over HTTPS, and use a real domain/onion hostname.
- This MVP is not a substitute for a security audit. Add HTTPS, rate limiting at a reverse proxy, encrypted-at-rest storage, monitoring, backups, and a production database before public use.

## Run one shared VX node in Tor

VX is a single-server application, not a federated or peer-to-peer network. One host operator can run it continuously and share its onion URL; everyone else uses that same URL in Tor Browser. They do **not** need to run a server themselves. The host holds the shared accounts and messages, so if it stops, the shared service is unavailable until it starts again.

On Windows, with Node.js 20+ and Tor installed:

1. Download this repository as ZIP (or clone it), extract it, then copy `.env.example` to `.env` and set the mail credentials on the host. Do not commit `.env`.
2. Create a machine-local Tor configuration once: `powershell -ExecutionPolicy Bypass -File .\scripts\Initialize-TorConfig.ps1`.
3. Start both processes: `powershell -ExecutionPolicy Bypass -File .\scripts\Start-VX.ps1 -TorExe "C:\path\to\tor.exe"`.
4. Wait briefly, then print the shareable service address: `powershell -ExecutionPolicy Bypass -File .\scripts\Get-VXOnionAddress.ps1`.
5. Give that `http://exampleonionaddress.onion/` address to users. They open it in Tor Browser and sign in. The server remains bound to `127.0.0.1`; only Tor exposes it.

The generated `tor/torrc.local`, `tor/vx_service` private key, runtime files, logs, downloads, and bundled Tor binaries are local-only and deliberately ignored by Git. For automatic startup of the host after Windows sign-in, run `scripts\Install-VX-Autostart.ps1` with the same `-TorExe` path.

Tor protects access to the web/signalling server. The e-mail provider configured in `.env` is a separate network service; Gmail SMTP is not Tor-only by itself. Browser WebRTC is disabled in this mode so no direct or TURN media path is created.