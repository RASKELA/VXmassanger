"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { URL } = require("node:url");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const UPLOADS = path.join(PUBLIC, "uploads");
const DATA_FILE = path.join(ROOT, "data", "store.json");

function readEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
readEnvFile();

const config = {
  host: process.env.HOST === "::1" ? "::1" : "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  torOnly: process.env.TOR_ONLY !== "false",
  devOtp: process.env.DEV_SHOW_OTP === "true" || (!process.env.SMTP_HOST && process.env.NODE_ENV !== "production"),
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  },
  iceServers: parseIceServers(process.env.ICE_SERVERS),
};

function parseIceServers(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("ICE_SERVERS is not valid JSON; calls will use no relay configuration.");
    return [];
  }
}

let db = { users: [], otpRequests: {}, conversations: {}, groups: [], groupMessages: {}, stickerPacks: [], signals: [] };
let saveQueue = Promise.resolve();
const sessions = new Map();
const eventClients = new Map();

async function initialise() {
  await fsp.mkdir(UPLOADS, { recursive: true });
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    db = { ...db, ...JSON.parse(await fsp.readFile(DATA_FILE, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Starting with a new data store:", error.message);
    await save();
  }
  db.users ||= [];
  db.otpRequests ||= {};
  db.conversations ||= {};
  db.groups ||= [];
  db.groupMessages ||= {};
  db.stickerPacks ||= [];
  db.signals ||= [];
  for (const user of db.users) user.installedStickerPackIds ||= [];
  for (const group of db.groups) {
    group.members ||= [];
    group.readBy ||= {};
    for (const memberId of group.members) group.readBy[memberId] ||= group.createdAt;
  }
  for (const pack of db.stickerPacks) pack.stickers ||= [];
}

function save() {
  const snapshot = JSON.stringify(db, null, 2);
  saveQueue = saveQueue.then(() => fsp.writeFile(DATA_FILE, snapshot, { mode: 0o600 }));
  return saveQueue;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function json(res, status, body) {
  const output = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(output),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(output);
}

function fail(res, status, error) {
  json(res, status, { error });
}

function readBody(req, max = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, max) {
  const raw = await readBody(req, max);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
}

function requireAuth(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    fail(res, 401, "Your session has expired. Sign in again.");
    return null;
  }
  const user = db.users.find((item) => item.id === session.userId);
  if (!user) {
    fail(res, 401, "Unknown session.");
    return null;
  }
  return user;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name || user.email.split("@")[0], bio: user.bio || "", avatar: user.avatar || null, online: Boolean(eventClients.get(user.id)?.size) };
}

function conversationId(a, b) {
  return [a, b].sort().join(":");
}

function conversationFor(a, b) {
  return db.conversations[conversationId(a, b)] || [];
}

function publicGroup(group) {
  return {
    id: group.id,
    title: group.title,
    ownerId: group.ownerId,
    members: group.members,
    memberProfiles: group.members.map((memberId) => publicUser(db.users.find((item) => item.id === memberId) || { id: memberId, email: "unknown@vx", name: "Unknown" })),
    createdAt: group.createdAt,
  };
}

function groupFor(id) {
  return db.groups.find((group) => group.id === id);
}

function isGroupMember(group, userId) {
  return Boolean(group && group.members.includes(userId));
}

function findMessage(messageId) {
  for (const [key, messages] of Object.entries(db.conversations)) {
    const message = messages.find((item) => item.id === messageId);
    if (message) return { kind: "direct", members: key.split(":"), messages, message };
  }
  for (const [groupId, messages] of Object.entries(db.groupMessages)) {
    const message = messages.find((item) => item.id === messageId);
    if (message) return { kind: "group", group: groupFor(groupId), messages, message };
  }
  return null;
}

function canAccessMessage(context, userId) {
  return context?.kind === "direct" ? context.members.includes(userId) : isGroupMember(context?.group, userId);
}

function replyPreview(message) {
  if (!message.replyTo) return null;
  const original = findMessage(message.replyTo)?.message;
  if (!original) return { id: message.replyTo, unavailable: true };
  const sender = db.users.find((item) => item.id === original.from);
  return {
    id: original.id,
    from: original.from,
    sender: publicUser(sender || { id: original.from, email: "unknown@vx", name: "Unknown" }),
    text: original.deletedAt ? "" : original.text,
    attachment: original.deletedAt ? null : original.attachment,
    sticker: original.deletedAt ? null : original.sticker,
    deletedAt: original.deletedAt || null,
  };
}

function publicMessage(message) {
  return { ...message, reply: replyPreview(message) };
}

function unreadDirect(messages, userId) {
  return messages.filter((message) => message.to === userId && !message.readAt && !message.deletedAt).length;
}

function unreadGroup(messages, group, userId) {
  const readAt = group.readBy?.[userId] || group.createdAt;
  return messages.filter((message) => message.from !== userId && !message.deletedAt && message.createdAt > readAt).length;
}

function stickerRecord(stickerId) {
  for (const pack of db.stickerPacks) {
    const sticker = pack.stickers.find((item) => item.id === stickerId);
    if (sticker) return { pack, sticker };
  }
  return null;
}

function publicStickerPack(pack, userId) {
  return {
    id: pack.id,
    title: pack.title,
    ownerId: pack.ownerId,
    createdAt: pack.createdAt,
    installed: pack.ownerId === userId || Boolean(db.users.find((item) => item.id === userId)?.installedStickerPackIds?.includes(pack.id)),
    stickers: pack.stickers.map((sticker) => ({ id: sticker.id, attachment: sticker.attachment, emoji: sticker.emoji || "", createdAt: sticker.createdAt })),
  };
}

function cleanSignals() {
  const now = Date.now();
  db.signals = db.signals.filter((signal) => signal.expiresAt > now && !signal.deliveredAt);
}

function cookieValue(req, key) {
  const found = String(req.headers.cookie || "").split(";").map((value) => value.trim()).find((value) => value.startsWith(`${key}=`));
  return found ? decodeURIComponent(found.slice(key.length + 1)) : "";
}

function setEventsCookie(res, token) {
  res.setHeader("Set-Cookie", `vx_events=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/events`);
}

function eventUser(req) {
  const session = sessions.get(cookieValue(req, "vx_events"));
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((item) => item.id === session.userId) || null;
}

function publish(userIds, type, payload = {}) {
  for (const userId of new Set(userIds)) {
    const clients = eventClients.get(userId);
    if (!clients) continue;
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) response.write(line);
  }
}

function publishForContext(context, type = "update") {
  if (context.kind === "direct") publish(context.members, type);
  else if (context.group) publish(context.group.members, type);
}

function sendMail({ to, subject, text }) {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass || !config.smtp.from) {
    return Promise.resolve({ delivered: false, reason: "SMTP is not configured" });
  }
  if (!config.smtp.secure) {
    return Promise.reject(new Error("This bundled SMTP client supports implicit TLS only. Set SMTP_SECURE=true and use port 465."));
  }
  const mail = [
    `From: ${config.smtp.from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text.replace(/^\./gm, ".."),
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: config.smtp.host, port: config.smtp.port, servername: config.smtp.host, minVersion: "TLSv1.2" });
    let buffer = "";
    const waiters = [];
    const nextResponse = () => new Promise((resolveResponse, rejectResponse) => waiters.push({ resolve: resolveResponse, reject: rejectResponse }));
    const flush = () => {
      const match = buffer.match(/(?:^|\r\n)(\d{3}) [^\r\n]*(?:\r\n)?$/);
      if (!match || !waiters.length) return;
      const waiter = waiters.shift();
      const response = buffer;
      buffer = "";
      waiter.resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk; flush(); });
    socket.on("error", (error) => {
      while (waiters.length) waiters.shift().reject(error);
      reject(error);
    });
    const command = async (line, allowed = [250]) => {
      const responsePromise = nextResponse();
      if (line) socket.write(`${line}\r\n`);
      const response = await responsePromise;
      const code = Number(response.match(/(?:^|\r\n)(\d{3}) [^\r\n]*(?:\r\n)?$/)?.[1]);
      if (!allowed.includes(code)) throw new Error(`SMTP rejected command (${code || "no response"}).`);
    };
    socket.once("secureConnect", async () => {
      try {
        await command(null, [220]);
        await command("EHLO vx.local");
        await command("AUTH LOGIN", [334]);
        await command(Buffer.from(config.smtp.user).toString("base64"), [334]);
        await command(Buffer.from(config.smtp.pass).toString("base64"), [235]);
        await command(`MAIL FROM:<${config.smtp.user}>`);
        await command(`RCPT TO:<${to}>`, [250, 251]);
        await command("DATA", [354]);
        await command(`${mail}\r\n.`, [250]);
        await command("QUIT", [221]);
        socket.end();
        resolve({ delivered: true });
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

async function serveFile(res, filePath, contentType) {
  try {
    const content = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(content);
  } catch {
    fail(res, 404, "Not found.");
  }
}

function safeUploadPath(name) {
  const base = path.basename(name);
  if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(base)) return null;
  return path.join(UPLOADS, base);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' stun: turn:; style-src 'self'; script-src 'self'");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS" });
    return res.end();
  }
  if (req.method === "GET" && route === "/") return serveFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
  if (req.method === "GET" && route === "/styles.css") return serveFile(res, path.join(PUBLIC, "styles.css"), "text/css; charset=utf-8");
  if (req.method === "GET" && route === "/app.js") return serveFile(res, path.join(PUBLIC, "app.js"), "application/javascript; charset=utf-8");
  if (req.method === "GET" && route === "/p2p.js") return serveFile(res, path.join(PUBLIC, "p2p.js"), "application/javascript; charset=utf-8");
  if (req.method === "GET" && route === "/relay.js") return serveFile(res, path.join(PUBLIC, "relay.js"), "application/javascript; charset=utf-8");
  if (req.method === "GET" && route === "/p2p-config") return json(res, 200, { iceServers: config.iceServers });
  if (req.method === "GET" && route === "/vx-icon.png") return serveFile(res, path.join(ROOT, "1.png"), "image/png");
  if (req.method === "GET" && route.startsWith("/uploads/")) {
    const file = safeUploadPath(route.slice("/uploads/".length));
    const ext = path.extname(file || "").toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext];
    return file && mime ? serveFile(res, file, mime) : fail(res, 404, "Not found.");
  }

  if (req.method === "POST" && route === "/api/auth/request-code") {
    const body = await readJson(req);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) return fail(res, 400, "Enter a valid e-mail address.");
    const existing = db.otpRequests[email];
    if (existing?.lastSentAt && Date.now() - existing.lastSentAt < 60_000) return fail(res, 429, "Wait one minute before requesting another code.");
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    db.otpRequests[email] = {
      codeHash: crypto.createHash("sha256").update(`${email}:${code}`).digest("hex"),
      expiresAt: Date.now() + 10 * 60_000,
      lastSentAt: Date.now(),
      attempts: 0,
    };
    await save();
    try {
      const mailResult = await sendMail({
        to: email,
        subject: "VX — your one-time sign-in code",
        text: `Your VX verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this e-mail.`,
      });
      const response = { ok: true, message: mailResult.delivered ? "Code sent to your e-mail." : "Development mode: code generated." };
      if (!mailResult.delivered && config.devOtp) response.devCode = code;
      if (!mailResult.delivered && !config.devOtp) return fail(res, 503, "E-mail delivery is not configured.");
      return json(res, 200, response);
    } catch (error) {
      console.error("SMTP error:", error.message);
      return fail(res, 502, "Unable to send the e-mail code. Check SMTP settings.");
    }
  }

  if (req.method === "POST" && route === "/api/auth/verify") {
    const body = await readJson(req);
    const email = normaliseEmail(body.email);
    const request = db.otpRequests[email];
    const suppliedHash = crypto.createHash("sha256").update(`${email}:${String(body.code || "")}`).digest("hex");
    if (!request || request.expiresAt < Date.now() || request.attempts >= 5 || !crypto.timingSafeEqual(Buffer.from(request.codeHash), Buffer.from(suppliedHash))) {
      if (request) { request.attempts += 1; await save(); }
      return fail(res, 401, "Incorrect or expired code.");
    }
    delete db.otpRequests[email];
    let user = db.users.find((item) => item.email === email);
    if (!user) {
      user = { id: id("u"), email, name: email.split("@")[0], createdAt: new Date().toISOString() };
      db.users.push(user);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60_000 });
    await save();
    return json(res, 200, { token, user: publicUser(user) });
  }

  if (req.method === "GET" && route === "/api/events") {
    const subscribedUser = eventUser(req);
    if (!subscribedUser) return fail(res, 401, "Live updates need a current session.");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("event: connected\ndata: {}\n\n");
    const clients = eventClients.get(subscribedUser.id) || new Set();
    clients.add(res);
    eventClients.set(subscribedUser.id, clients);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
      if (!clients.size) eventClients.delete(subscribedUser.id);
    });
    return;
  }

  const user = route.startsWith("/api/") ? requireAuth(req, res) : null;
  if (route.startsWith("/api/") && !user) return;
  if (req.method === "GET" && route === "/api/config") return json(res, 200, { iceServers: config.iceServers, torOnly: config.torOnly });
  if (req.method === "POST" && route === "/api/events/authorize") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    setEventsCookie(res, token);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && route === "/api/me") return json(res, 200, { user: publicUser(user) });
  if (req.method === "PUT" && route === "/api/me") {
    const body = await readJson(req);
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const bio = String(body.bio || "").trim().slice(0, 140);
    const avatar = typeof body.avatar === "string" && /^\/uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(body.avatar) ? body.avatar : user.avatar || null;
    if (name.length < 1) return fail(res, 400, "Display name is required.");
    user.name = name; user.bio = bio; user.avatar = avatar;
    await save();
    publish([user.id], "profile");
    return json(res, 200, { user: publicUser(user) });
  }

  if (req.method === "GET" && route === "/api/users") {
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    if (query.length < 2) return json(res, 200, { users: [] });
    const users = db.users.filter((item) => item.id !== user.id && `${item.name} ${item.email}`.toLowerCase().includes(query)).slice(0, 10).map(publicUser);
    return json(res, 200, { users });
  }

  if (req.method === "GET" && route === "/api/sticker-packs") {
    return json(res, 200, { packs: db.stickerPacks.map((pack) => publicStickerPack(pack, user.id)) });
  }

  if (req.method === "POST" && route === "/api/sticker-packs") {
    const body = await readJson(req);
    const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (title.length < 2) return fail(res, 400, "Sticker pack title must have at least two characters.");
    const pack = { id: id("sp"), title, ownerId: user.id, stickers: [], createdAt: new Date().toISOString() };
    db.stickerPacks.push(pack);
    user.installedStickerPackIds ||= [];
    if (!user.installedStickerPackIds.includes(pack.id)) user.installedStickerPackIds.push(pack.id);
    await save();
    return json(res, 201, { pack: publicStickerPack(pack, user.id) });
  }

  const stickerPackStickerMatch = route.match(/^\/api\/sticker-packs\/([^/]+)\/stickers$/);
  if (req.method === "POST" && stickerPackStickerMatch) {
    const pack = db.stickerPacks.find((item) => item.id === stickerPackStickerMatch[1]);
    if (!pack) return fail(res, 404, "Sticker pack not found.");
    if (pack.ownerId !== user.id) return fail(res, 403, "Only the sticker pack creator can add stickers.");
    if (pack.stickers.length >= 120) return fail(res, 400, "A sticker pack can contain up to 120 stickers.");
    const body = await readJson(req);
    const attachment = typeof body.attachment === "string" && /^\/uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(body.attachment) ? body.attachment : null;
    if (!attachment || !fs.existsSync(safeUploadPath(attachment.slice("/uploads/".length)) || "")) return fail(res, 400, "Upload a valid sticker image first.");
    const emoji = String(body.emoji || "").trim().slice(0, 16);
    const sticker = { id: id("st"), attachment, emoji, createdAt: new Date().toISOString() };
    pack.stickers.push(sticker);
    await save();
    return json(res, 201, { pack: publicStickerPack(pack, user.id), sticker });
  }

  const stickerPackInstallMatch = route.match(/^\/api\/sticker-packs\/([^/]+)\/install$/);
  if (req.method === "POST" && stickerPackInstallMatch) {
    const pack = db.stickerPacks.find((item) => item.id === stickerPackInstallMatch[1]);
    if (!pack) return fail(res, 404, "Sticker pack not found.");
    user.installedStickerPackIds ||= [];
    if (!user.installedStickerPackIds.includes(pack.id)) user.installedStickerPackIds.push(pack.id);
    await save();
    return json(res, 200, { pack: publicStickerPack(pack, user.id) });
  }

  if (req.method === "GET" && route === "/api/chats") {
    const directChats = Object.entries(db.conversations).flatMap(([key, messages]) => {
      if (!key.split(":").includes(user.id) || !messages.length) return [];
      const peerId = key.split(":").find((item) => item !== user.id);
      const peer = db.users.find((item) => item.id === peerId);
      const last = messages[messages.length - 1];
      return peer ? [{ type: "direct", user: publicUser(peer), unread: unreadDirect(messages, user.id), last: { text: last.text, attachment: last.attachment, sticker: last.sticker || null, deletedAt: last.deletedAt || null, createdAt: last.createdAt, from: last.from } }] : [];
    });
    const groupChats = db.groups.filter((group) => isGroupMember(group, user.id)).map((group) => {
      const messages = db.groupMessages[group.id] || [];
      const last = messages[messages.length - 1] || { text: "", attachment: null, sticker: null, createdAt: group.createdAt, from: "" };
      return { type: "group", group: publicGroup(group), unread: unreadGroup(messages, group, user.id), last: { text: last.text, attachment: last.attachment, sticker: last.sticker || null, deletedAt: last.deletedAt || null, createdAt: last.createdAt, from: last.from } };
    });
    const chats = [...directChats, ...groupChats].sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt));
    return json(res, 200, { chats });
  }

  if (req.method === "GET" && route === "/api/messages") {
    const group = groupFor(url.searchParams.get("group"));
    if (group) {
      if (!isGroupMember(group, user.id)) return fail(res, 403, "You are not a member of this group.");
      const messages = (db.groupMessages[group.id] || []).slice(-200);
      group.readBy ||= {};
      group.readBy[user.id] = new Date().toISOString();
      await save();
      const visibleMessages = messages.map((message) => ({ ...publicMessage(message), sender: publicUser(db.users.find((item) => item.id === message.from) || { id: message.from, email: "unknown@vx", name: "Unknown" }) }));
      return json(res, 200, { type: "group", group: publicGroup(group), messages: visibleMessages });
    }
    const peer = db.users.find((item) => item.id === url.searchParams.get("with"));
    if (!peer || peer.id === user.id) return fail(res, 404, "Conversation recipient not found.");
    const messages = conversationFor(user.id, peer.id).slice(-200);
    let changed = false;
    for (const message of messages) {
      if (message.to === user.id && !message.readAt) { message.readAt = new Date().toISOString(); changed = true; }
    }
    if (changed) { await save(); publish([peer.id], "read"); }
    return json(res, 200, { type: "direct", peer: publicUser(peer), messages: messages.map(publicMessage) });
  }

  if (req.method === "POST" && route === "/api/messages") {
    const body = await readJson(req, 140 * 1024);
    const recipient = db.users.find((item) => item.id === body.to);
    const group = groupFor(body.groupId);
    const text = String(body.text || "").trim().slice(0, 4000);
    const attachment = typeof body.attachment === "string" && /^\/uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(body.attachment) ? body.attachment : null;
    const requestedSticker = typeof body.sticker === "string" ? body.sticker : "";
    const sticker = requestedSticker && stickerRecord(requestedSticker)?.pack && (stickerRecord(requestedSticker).pack.ownerId === user.id || user.installedStickerPackIds?.includes(stickerRecord(requestedSticker).pack.id)) ? stickerRecord(requestedSticker).sticker.attachment : null;
    const replyTo = typeof body.replyTo === "string" && body.replyTo.length <= 64 ? body.replyTo : null;
    if (!group && (!recipient || recipient.id === user.id)) return fail(res, 404, "Recipient not found.");
    if (group && !isGroupMember(group, user.id)) return fail(res, 403, "You are not a member of this group.");
    if (requestedSticker && !sticker) return fail(res, 400, "Choose a sticker from one of your installed packs.");
    if (sticker && (text || attachment)) return fail(res, 400, "Send a sticker as a separate message.");
    if (!text && !attachment && !sticker) return fail(res, 400, "Write a message, attach an image or choose a sticker.");
    if (replyTo) {
      const replyContext = findMessage(replyTo);
      const sameGroup = Boolean(group && replyContext?.kind === "group" && replyContext.group?.id === group.id);
      const sameDirect = Boolean(!group && replyContext?.kind === "direct" && replyContext.members.includes(user.id) && replyContext.members.includes(recipient.id));
      if (!sameGroup && !sameDirect) return fail(res, 400, "You can reply only to a message in this conversation.");
    }
    const message = { id: id("m"), from: user.id, to: group ? null : recipient.id, groupId: group?.id || null, text, attachment, sticker, replyTo, reactions: {}, createdAt: new Date().toISOString() };
    if (group) {
      db.groupMessages[group.id] ||= [];
      db.groupMessages[group.id].push(message);
    } else {
      const key = conversationId(user.id, recipient.id);
      db.conversations[key] ||= [];
      db.conversations[key].push(message);
    }
    await save();
    publish(group ? group.members : [user.id, recipient.id], "message");
    return json(res, 201, { message: publicMessage(message) });
  }

  if (req.method === "POST" && route === "/api/groups") {
    const body = await readJson(req);
    const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (title.length < 2) return fail(res, 400, "Group title must have at least two characters.");
    const requestedEmails = Array.isArray(body.members) ? body.members.map(normaliseEmail).filter(isEmail) : [];
    const requestedIds = Array.isArray(body.memberIds) ? body.memberIds.filter((item) => typeof item === "string" && item.length <= 64) : [];
    const memberUsers = db.users.filter((item) => requestedEmails.includes(item.email) || requestedIds.includes(item.id));
    const members = [...new Set([user.id, ...memberUsers.map((item) => item.id)])];
    if (members.length < 2) return fail(res, 400, "Add at least one registered VX contact by e-mail.");
    const createdAt = new Date().toISOString();
    const group = { id: id("g"), title, ownerId: user.id, members, readBy: Object.fromEntries(members.map((memberId) => [memberId, createdAt])), createdAt };
    db.groups.push(group); db.groupMessages[group.id] = [];
    await save();
    publish(members, "group");
    return json(res, 201, { group: publicGroup(group) });
  }

  const groupMemberMatch = route.match(/^\/api\/groups\/([^/]+)\/members$/);
  if (req.method === "POST" && groupMemberMatch) {
    const group = groupFor(groupMemberMatch[1]);
    if (!group) return fail(res, 404, "Group not found.");
    if (group.ownerId !== user.id) return fail(res, 403, "Only the group creator can add members.");
    const body = await readJson(req);
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const member = db.users.find((item) => item.id === memberId || item.email === normaliseEmail(body.email));
    if (!member) return fail(res, 404, "That e-mail has not registered on VX yet.");
    if (!group.members.includes(member.id)) {
      group.members.push(member.id);
      group.readBy ||= {};
      group.readBy[member.id] = new Date().toISOString();
    }
    await save();
    publish(group.members, "group");
    return json(res, 200, { group: publicGroup(group) });
  }

  const groupMemberDeleteMatch = route.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
  if (req.method === "DELETE" && groupMemberDeleteMatch) {
    const group = groupFor(groupMemberDeleteMatch[1]);
    const memberId = groupMemberDeleteMatch[2];
    if (!group || !isGroupMember(group, user.id) || !isGroupMember(group, memberId)) return fail(res, 404, "Group member not found.");
    if (memberId === group.ownerId) return fail(res, 400, "The group creator cannot leave or be removed. Transfer ownership before doing that.");
    if (memberId !== user.id && group.ownerId !== user.id) return fail(res, 403, "Only the group creator can remove members.");
    group.members = group.members.filter((item) => item !== memberId);
    if (group.readBy) delete group.readBy[memberId];
    await save();
    publish([...group.members, memberId], "group");
    return json(res, 200, { group: publicGroup(group), removedUserId: memberId });
  }

  const messageMatch = route.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const context = findMessage(messageMatch[1]);
    if (!context || !canAccessMessage(context, user.id)) return fail(res, 404, "Message not found.");
    if (context.message.from !== user.id) return fail(res, 403, "Only the sender can change this message.");
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const text = String(body.text || "").trim().slice(0, 4000);
      if (!text) return fail(res, 400, "Edited message cannot be empty.");
      context.message.text = text; context.message.editedAt = new Date().toISOString();
    } else {
      context.message.text = ""; context.message.attachment = null; context.message.sticker = null; context.message.deletedAt = new Date().toISOString();
    }
    await save(); publishForContext(context, "message");
    return json(res, 200, { message: publicMessage(context.message) });
  }

  const reactionMatch = route.match(/^\/api\/messages\/([^/]+)\/reactions$/);
  if (req.method === "POST" && reactionMatch) {
    const context = findMessage(reactionMatch[1]);
    if (!context || !canAccessMessage(context, user.id) || context.message.deletedAt) return fail(res, 404, "Message not found.");
    const body = await readJson(req);
    const emoji = String(body.emoji || "");
    if (!["⚡", "♥", "🔥", "👍", "😂"].includes(emoji)) return fail(res, 400, "Unsupported reaction.");
    context.message.reactions ||= {};
    const reactions = new Set(context.message.reactions[emoji] || []);
    reactions.has(user.id) ? reactions.delete(user.id) : reactions.add(user.id);
    reactions.size ? context.message.reactions[emoji] = [...reactions] : delete context.message.reactions[emoji];
    await save(); publishForContext(context, "message");
    return json(res, 200, { message: publicMessage(context.message) });
  }

  if (req.method === "POST" && route === "/api/uploads") {
    const type = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[type];
    if (!extension) return fail(res, 415, "Only PNG, JPEG, GIF and WebP images are supported.");
    const image = await readBody(req, 5 * 1024 * 1024);
    if (!image.length) return fail(res, 400, "Empty image.");
    const filename = `${id("img")}.${extension}`;
    await fsp.writeFile(path.join(UPLOADS, filename), image, { mode: 0o600 });
    return json(res, 201, { attachment: `/uploads/${filename}` });
  }

  if (req.method === "POST" && route === "/api/typing") {
    const body = await readJson(req);
    const recipient = db.users.find((item) => item.id === body.to);
    const group = groupFor(body.groupId);
    const typing = Boolean(body.typing);
    if (!group && (!recipient || recipient.id === user.id)) return fail(res, 404, "Recipient not found.");
    if (group && !isGroupMember(group, user.id)) return fail(res, 403, "You are not a member of this group.");
    const sender = publicUser(user);
    if (group) {
      publish(group.members.filter((memberId) => memberId !== user.id), "typing", { type: "group", groupId: group.id, user: sender, typing });
    } else {
      publish([recipient.id], "typing", { type: "direct", peerId: user.id, user: sender, typing });
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && route === "/api/signals") {
    cleanSignals();
    const signals = db.signals.filter((signal) => signal.to === user.id && !signal.deliveredAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const signal of signals) signal.deliveredAt = Date.now();
    if (signals.length) await save();
    return json(res, 200, { signals: signals.map((signal) => ({ ...signal, fromUser: publicUser(db.users.find((item) => item.id === signal.from) || { id: signal.from, email: "unknown@vx", name: "VX contact" }) })) });
  }

  if (req.method === "POST" && route === "/api/signals") {
    if (config.torOnly) return fail(res, 403, "Calls are disabled in Tor-only mode because browser WebRTC media is not guaranteed to stay on Tor.");
    const body = await readJson(req, 96 * 1024);
    const recipient = db.users.find((item) => item.id === body.to);
    const kinds = new Set(["call-offer", "call-answer", "ice-candidate", "call-hangup"]);
    if (!recipient || recipient.id === user.id || !kinds.has(body.type) || typeof body.payload !== "object") return fail(res, 400, "Invalid call signal.");
    cleanSignals();
    db.signals.push({ id: id("s"), from: user.id, to: recipient.id, type: body.type, payload: body.payload, createdAt: new Date().toISOString(), expiresAt: Date.now() + 2 * 60_000 });
    await save();
    publish([recipient.id], "signal");
    return json(res, 201, { ok: true });
  }

  fail(res, 404, "Not found.");
}

async function main() {
  await initialise();
  const server = http.createServer((req, res) => handle(req, res).catch((error) => {
    console.error("Request error:", error);
    if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : "Unexpected server error.");
    else res.end();
  }));
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`VX is already running at http://${config.host}:${config.port}. Open that address, or change PORT in .env.`);
    } else {
      console.error("VX could not start:", error.message);
    }
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`VX is running at http://${config.host}:${config.port}`);
    console.log(config.smtp.host ? `SMTP delivery: ${config.smtp.host}:${config.smtp.port}` : "SMTP delivery: not configured (local development mode only)");
  });
}
main();
