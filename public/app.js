"use strict";

const state = {
  token: localStorage.getItem("vx_token"),
  me: null,
  selected: null,
  chats: [],
  messages: [],
  stickerPacks: [],
  activeStickerPackId: null,
  replyingTo: null,
  remoteTyping: new Map(),
  groupMemberChoices: new Map(),
  localTyping: null,
  localTypingTimer: null,
  config: { iceServers: [], torOnly: true },
  poller: null,
  eventSource: null,
  liveTimer: null,
  call: null,
  pendingCandidates: new Map(),
};
const el = (selector) => document.querySelector(selector);
const authView = el("#authView"), appView = el("#appView"), toast = el("#toast");
let toastTimer, searchTimer, groupSearchTimer, groupSearchVersion = 0;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
function avatar(user) { return user?.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="">` : escapeHtml((user?.name || user?.email || "V").slice(0, 1).toUpperCase()); }
function label(user) { return escapeHtml(user?.name || user?.email || "VX contact"); }
function shortDate(value) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function preview(chat) { return chat.last.deletedAt ? "Message deleted" : chat.last.sticker ? "Sticker" : chat.last.attachment ? "Image" : (chat.last.text || "New channel"); }
function directChat(user) { return { type: "direct", user }; }
function groupChat(group) { return { type: "group", group }; }
function selectedId(chat) { return chat.type === "direct" ? chat.user.id : chat.group.id; }
function sameChat(a, b) { return Boolean(a && b && a.type === b.type && selectedId(a) === selectedId(b)); }
function selectedPeer() { return state.selected?.type === "direct" ? state.selected.user : null; }

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.json) { headers["Content-Type"] = "application/json"; options.body = JSON.stringify(options.json); }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) signOut(false);
    throw new Error(data.error || "Request failed.");
  }
  return data;
}
async function uploadImage(file) {
  if (!file) return null;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be 5 MB or smaller.");
  return (await api("/api/uploads", { method: "POST", body: file, headers: { "Content-Type": file.type } })).attachment;
}
function setAuthStatus(message, error = false) {
  const status = el("#authStatus"); status.textContent = message; status.classList.toggle("error", error);
}

el("#emailForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = el("#email").value.trim();
  if (!email) return setAuthStatus("Enter your e-mail address.", true);
  setAuthStatus("Requesting a secure code…");
  try {
    const result = await api("/api/auth/request-code", { method: "POST", json: { email } });
    el("#emailForm").classList.add("hidden"); el("#codeForm").classList.remove("hidden"); el("#code").focus();
    setAuthStatus(result.devCode ? `Local development code: ${result.devCode}` : result.message);
  } catch (error) { setAuthStatus(error.message, true); }
});
el("#codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = el("#email").value.trim(), code = el("#code").value.trim();
  setAuthStatus("Verifying…");
  try {
    const result = await api("/api/auth/verify", { method: "POST", json: { email, code } });
    state.token = result.token; state.me = result.user; localStorage.setItem("vx_token", state.token); await enterApp();
  } catch (error) { setAuthStatus(error.message, true); }
});
el("#changeEmail").addEventListener("click", () => {
  el("#codeForm").classList.add("hidden"); el("#emailForm").classList.remove("hidden"); el("#email").focus(); setAuthStatus("");
});

function signOut(notify = true) {
  stopLocalTyping(); clearInterval(state.poller); clearTimeout(state.liveTimer); state.eventSource?.close(); state.eventSource = null; endCall(false);
  localStorage.removeItem("vx_token"); state.token = null; state.me = null; state.selected = null; state.chats = []; state.messages = []; state.replyingTo = null; state.remoteTyping.clear();
  appView.classList.add("hidden"); authView.classList.remove("hidden");
  el("#codeForm").classList.add("hidden"); el("#emailForm").classList.remove("hidden"); el("#code").value = "";
  if (notify) setAuthStatus("Signed out.");
}
el("#logout").addEventListener("click", () => signOut());

async function enterApp() {
  try {
    const [profile, config, packs] = await Promise.all([api("/api/me"), api("/api/config"), api("/api/sticker-packs")]);
    state.me = profile.user; state.config = config; state.stickerPacks = packs.packs; renderIdentity(); renderStickerPicker();
    authView.classList.add("hidden"); appView.classList.remove("hidden");
    await refreshChats(); await connectLiveUpdates(); clearInterval(state.poller); state.poller = setInterval(poll, 15_000); poll();
  } catch (error) { setAuthStatus(error.message, true); signOut(false); }
}
function renderIdentity() { el("#myName").textContent = state.me.name; el("#myEmail").textContent = state.me.email; }
async function connectLiveUpdates() {
  await api("/api/events/authorize", { method: "POST" }); state.eventSource?.close();
  const source = new EventSource("/api/events"); state.eventSource = source;
  ["message", "read", "profile", "group", "signal"].forEach((eventName) => source.addEventListener(eventName, scheduleLiveSync));
  source.addEventListener("typing", (event) => { try { receiveTyping(JSON.parse(event.data)); } catch {} });
}
function scheduleLiveSync() { clearTimeout(state.liveTimer); state.liveTimer = setTimeout(() => poll(), 80); }

function typingKey(chat = state.selected) {
  if (!chat) return "";
  return chat.type === "direct" ? `direct:${chat.user.id}` : `group:${chat.group.id}`;
}
function typingDestination(chat = state.selected) {
  if (!chat) return null;
  return chat.type === "direct" ? { key: typingKey(chat), to: chat.user.id } : { key: typingKey(chat), groupId: chat.group.id };
}
function typingStatus(chat = state.selected) {
  const key = typingKey(chat), entry = state.remoteTyping.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { state.remoteTyping.delete(key); return null; }
  return entry;
}
function receiveTyping(payload) {
  const key = payload?.type === "direct" && payload.peerId ? `direct:${payload.peerId}` : payload?.type === "group" && payload.groupId ? `group:${payload.groupId}` : "";
  if (!key) return;
  if (payload.typing) {
    const expiresAt = Date.now() + 5000;
    state.remoteTyping.set(key, { name: payload.user?.name || "Someone", expiresAt });
    setTimeout(() => {
      const current = state.remoteTyping.get(key);
      if (current?.expiresAt === expiresAt) { state.remoteTyping.delete(key); if (typingKey() === key) renderChatHeader(); }
    }, 5100);
  } else state.remoteTyping.delete(key);
  if (typingKey() === key) renderChatHeader();
}
function updateLocalTyping() {
  const destination = typingDestination();
  if (!destination || !el("#messageText").value.trim()) return stopLocalTyping();
  if (state.localTyping?.key !== destination.key) stopLocalTyping();
  if (!state.localTyping) state.localTyping = { ...destination, lastSentAt: 0 };
  clearTimeout(state.localTypingTimer);
  state.localTypingTimer = setTimeout(stopLocalTyping, 4500);
  if (Date.now() - state.localTyping.lastSentAt < 2000) return;
  state.localTyping.lastSentAt = Date.now();
  api("/api/typing", { method: "POST", json: { ...destination, typing: true } }).catch(() => {});
}
function stopLocalTyping() {
  clearTimeout(state.localTypingTimer); state.localTypingTimer = null;
  const current = state.localTyping; if (!current) return;
  state.localTyping = null;
  api("/api/typing", { method: "POST", json: { to: current.to, groupId: current.groupId, typing: false } }).catch(() => {});
}

async function refreshStickerPacks() {
  const result = await api("/api/sticker-packs");
  state.stickerPacks = result.packs;
  renderStickerPicker();
  renderStickerPackForm();
}
function renderStickerPicker() {
  const panel = el("#stickerPanel"); if (!panel || !state.me) return;
  panel.innerHTML = state.stickerPacks.map((pack) => `<section class="sticker-pack ${pack.installed ? "" : "available"}"><header><strong>${escapeHtml(pack.title)}</strong>${pack.installed ? "" : `<button type="button" data-action="install-pack" data-pack-id="${pack.id}">Add</button>`}</header>${pack.installed ? `<div class="sticker-grid">${pack.stickers.map((sticker) => `<button type="button" data-action="send-sticker" data-sticker-id="${sticker.id}" title="${escapeHtml(sticker.emoji || pack.title)}"><img src="${escapeHtml(sticker.attachment)}" alt="${escapeHtml(sticker.emoji || "Sticker")}"></button>`).join("") || "<small>This pack has no stickers yet.</small>"}</div>` : "<small>Install this pack to use its stickers.</small>"}</section>`).join("") || '<div class="no-stickers">Create your first sticker pack from the sparkle button.</div>';
  panel.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", async () => {
    try {
      if (button.dataset.action === "send-sticker") { await sendSticker(button.dataset.stickerId); panel.classList.add("hidden"); }
      if (button.dataset.action === "install-pack") { await api(`/api/sticker-packs/${encodeURIComponent(button.dataset.packId)}/install`, { method: "POST" }); await refreshStickerPacks(); showToast("Sticker pack added."); }
    } catch (error) { showToast(error.message); }
  }));
}

async function refreshChats() {
  const result = await api("/api/chats"); state.chats = result.chats;
  const matching = state.selected && result.chats.find((chat) => sameChat(chat, state.selected));
  if (matching) state.selected = matching;
  else if (state.selected?.type === "group") clearSelectedChat();
  el("#chatCount").textContent = result.chats.length || "";
  el("#chatList").innerHTML = result.chats.map((chat) => {
    const identity = chat.type === "direct" ? chat.user : { name: chat.group.title, email: `${chat.group.members.length} members` };
    const mark = chat.type === "group" ? "G" : avatar(identity);
    const unread = Number(chat.unread || 0);
    return `<button class="chat-row ${sameChat(state.selected, chat) ? "active" : ""} ${unread ? "unread" : ""}" data-type="${chat.type}" data-id="${selectedId(chat)}"><span class="avatar">${mark}</span><div><strong>${label(identity)}</strong><small>${escapeHtml(preview(chat))}</small></div><div class="chat-meta"><time>${shortDate(chat.last.createdAt)}</time>${unread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}</div></button>`;
  }).join("");
  el("#chatList").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    const chat = state.chats.find((item) => item.type === button.dataset.type && selectedId(item) === button.dataset.id); if (chat) openChat(chat);
  }));
}

el("#userSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchUsers, 250); });
async function searchUsers() {
  const query = el("#userSearch").value.trim(), box = el("#searchResults"); if (query.length < 2) { box.innerHTML = ""; return; }
  try {
    const result = await api(`/api/users?q=${encodeURIComponent(query)}`);
    box.innerHTML = result.users.map((user) => `<button class="result" data-id="${user.id}"><span class="avatar">${avatar(user)}</span><div><strong>${label(user)}</strong><small>${user.online ? "● online now" : escapeHtml(user.email)}</small></div></button>`).join("") || "<small class=\"no-results\">No VX contact found yet</small>";
    box.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { const user = result.users.find((item) => item.id === button.dataset.id); if (user) openChat(directChat(user)); }));
  } catch (error) { showToast(error.message); }
}

async function openChat(chat) {
  if (!sameChat(state.selected, chat)) { stopLocalTyping(); state.replyingTo = null; state.messages = []; renderReplyBar(); }
  state.selected = chat; el("#userSearch").value = ""; el("#searchResults").innerHTML = ""; appView.classList.add("has-chat");
  renderChatHeader(); el("#composer").classList.remove("hidden"); await refreshMessages(); refreshChats();
}
function renderChatHeader() {
  if (!state.selected) return;
  const isGroup = state.selected.type === "group", identity = isGroup ? { name: state.selected.group.title } : state.selected.user;
  const typing = typingStatus();
  const defaultSubtitle = isGroup ? `${state.selected.group.members.length} members · group channel` : (identity.online ? "online now" : identity.email);
  const subtitle = typing ? `${typing.name} is typing…` : defaultSubtitle;
  const controls = isGroup ? `<button id="groupInfo" class="icon-button" title="Group members" aria-label="Group members">i</button>${state.selected.group.ownerId === state.me.id ? '<button id="addGroupMember" class="icon-button" title="Add member" aria-label="Add member">+</button>' : ""}` : (state.config.torOnly ? "" : '<button id="voiceCall" class="icon-button" aria-label="Voice call" title="Voice call">&#9742;</button><button id="videoCall" class="icon-button" aria-label="Video call" title="Video call">&#9654;</button>');  el("#chatHeader").innerHTML = `<button id="backToChats" class="icon-button" aria-label="Back to chats">&larr;</button><span class="avatar">${isGroup ? "G" : avatar(identity)}</span><div><strong>${label(identity)}</strong><small class="${typing ? "typing-status" : ""}">${escapeHtml(subtitle)}</small></div><div class="call-actions">${controls}</div>`;
  el("#backToChats").addEventListener("click", () => appView.classList.remove("has-chat"));
  el("#voiceCall")?.addEventListener("click", () => startCall("voice")); el("#videoCall")?.addEventListener("click", () => startCall("video")); el("#addGroupMember")?.addEventListener("click", addGroupMember); el("#groupInfo")?.addEventListener("click", openGroupDetails);
}
function replySummary(message) {
  if (message.deletedAt) return "Message deleted";
  return message.text || (message.sticker ? "Sticker" : message.attachment ? "Image" : "Message");
}
function renderReplyBar() {
  const bar = el("#replyBar"), message = state.replyingTo;
  if (!message) { bar.classList.add("hidden"); return; }
  const author = message.from === state.me.id ? "You" : (message.sender?.name || state.selected?.user?.name || "VX contact");
  el("#replyToName").textContent = author;
  el("#replyToText").textContent = replySummary(message);
  bar.classList.remove("hidden");
}
function renderMessageReply(message) {
  const reply = message.reply;
  if (!reply) return "";
  const author = reply.from === state.me.id ? "You" : (reply.sender?.name || "VX contact");
  const text = reply.unavailable ? "Original message is unavailable" : reply.deletedAt ? "Message deleted" : (reply.text || (reply.sticker ? "Sticker" : reply.attachment ? "Image" : "Message"));
  return `<div class="message-reply"><small>${escapeHtml(author)}</small><p>${escapeHtml(text)}</p></div>`;
}
function renderReactions(message) {
  const entries = Object.entries(message.reactions || {}); if (!entries.length) return "";
  return `<div class="reaction-row">${entries.map(([emoji, users]) => `<button class="reaction ${users.includes(state.me.id) ? "mine" : ""}" data-action="react" data-id="${message.id}" data-emoji="${emoji}">${emoji} ${users.length}</button>`).join("")}</div>`;
}
async function refreshMessages() {
  if (!state.selected) return;
  const endpoint = state.selected.type === "group" ? `/api/messages?group=${encodeURIComponent(state.selected.group.id)}` : `/api/messages?with=${encodeURIComponent(state.selected.user.id)}`;
  const result = await api(endpoint), pane = el("#messagePane"), oldHeight = pane.scrollHeight, atBottom = pane.scrollTop + pane.clientHeight >= oldHeight - 100;
  state.messages = result.messages;
  pane.classList.remove("empty-state");
  pane.innerHTML = result.messages.map((message) => {
    const mine = message.from === state.me.id, deleted = Boolean(message.deletedAt), sender = state.selected.type === "group" && !mine ? `<small class="sender-name">${label(message.sender)}</small>` : "";
    const actions = deleted ? "" : `<div class="message-actions"><button data-action="reply" data-id="${message.id}" title="Reply">Reply</button><button data-action="react" data-id="${message.id}" data-emoji="⚡" title="React">⚡</button>${mine && message.text ? `<button data-action="edit" data-id="${message.id}" title="Edit">Edit</button>` : ""}${mine ? `<button data-action="delete" data-id="${message.id}" title="Delete">Delete</button>` : ""}</div>`;
    const content = deleted ? "<p>Message deleted</p>" : `${renderMessageReply(message)}${message.sticker ? `<img class="sticker-image" src="${escapeHtml(message.sticker)}" alt="Sticker" loading="lazy">` : ""}${message.attachment ? `<img src="${escapeHtml(message.attachment)}" alt="Shared image" loading="lazy">` : ""}${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}`;
    const receipt = mine && state.selected.type === "direct" ? ` ${message.readAt ? "✓✓" : "✓"}` : "";
    return `<article class="message ${mine ? "mine" : ""} ${deleted ? "deleted" : ""}" data-message-id="${message.id}">${actions}${sender}${content}${renderReactions(message)}<time>${shortDate(message.createdAt)}${message.editedAt ? " · edited" : ""}${receipt}</time></article>`;
  }).join("") || "<div class=\"empty-state\"><div class=\"empty-mark\">◌</div><h2>Open channel</h2><p>Send the first signal.</p></div>";
  if (atBottom || !result.messages.length) pane.scrollTop = pane.scrollHeight;
}
el("#messagePane").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const id = button.dataset.id, action = button.dataset.action;
  try {
    if (action === "reply") {
      const message = state.messages.find((item) => item.id === id);
      if (!message) return;
      state.replyingTo = message; renderReplyBar(); el("#messageText").focus(); return;
    }
    if (action === "react") await api(`/api/messages/${encodeURIComponent(id)}/reactions`, { method: "POST", json: { emoji: button.dataset.emoji || "⚡" } });
    if (action === "edit") { const text = window.prompt("Edit message", button.closest("article").querySelector("p")?.textContent || ""); if (text === null) return; await api(`/api/messages/${encodeURIComponent(id)}`, { method: "PATCH", json: { text } }); }
    if (action === "delete" && window.confirm("Delete this message for everyone?")) await api(`/api/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshMessages();
  } catch (error) { showToast(error.message); }
});

function resizeComposer() { const textarea = el("#messageText"); textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight, 110)}px`; }
el("#messageText").addEventListener("input", () => { resizeComposer(); updateLocalTyping(); });
el("#messageText").addEventListener("blur", () => setTimeout(stopLocalTyping, 120));
el("#attachButton").addEventListener("click", () => el("#imageInput").click());
el("#stickerButton").addEventListener("click", () => { renderStickerPicker(); el("#stickerPanel").classList.toggle("hidden"); });
el("#cancelReply").addEventListener("click", () => { state.replyingTo = null; renderReplyBar(); });
async function sendSticker(stickerId) {
  if (!state.selected) return;
  stopLocalTyping();
  const destination = state.selected.type === "group" ? { groupId: state.selected.group.id } : { to: state.selected.user.id };
  await api("/api/messages", { method: "POST", json: { ...destination, sticker: stickerId, replyTo: state.replyingTo?.id || null } });
  state.replyingTo = null; renderReplyBar(); await Promise.all([refreshMessages(), refreshChats()]);
}
el("#composer").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!state.selected) return;
  const text = el("#messageText").value.trim(), image = el("#imageInput").files[0]; if (!text && !image) return;
  const send = el(".send-button"); send.disabled = true; stopLocalTyping();
  try {
    const attachment = await uploadImage(image), destination = state.selected.type === "group" ? { groupId: state.selected.group.id } : { to: state.selected.user.id };
    await api("/api/messages", { method: "POST", json: { ...destination, text, attachment, replyTo: state.replyingTo?.id || null } });
    state.replyingTo = null; renderReplyBar(); el("#messageText").value = ""; el("#imageInput").value = ""; resizeComposer(); await Promise.all([refreshMessages(), refreshChats()]);
  } catch (error) { showToast(error.message); } finally { send.disabled = false; }
});
function openModal(id) { el(id).classList.remove("hidden"); }
function closeModals() { document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden")); }
document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", closeModals));
document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) closeModals(); }));
async function copyInvite() {
  const address = window.location.origin;
  const invitation = `Join me on VX: ${address}\n\nOpen this same address and sign in with your e-mail to find me and join groups.`;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(invitation);
    else {
      const field = document.createElement("textarea");
      field.value = invitation; field.setAttribute("readonly", "");
      field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(field); field.select();
      const copied = document.execCommand("copy"); field.remove();
      if (!copied) throw new Error("Clipboard access was denied.");
    }
    showToast("VX invitation copied. Send it privately to your friend.");
  } catch (error) { showToast(`Could not copy the invitation: ${error.message}`); }
}
function renderGroupMemberChoices() {
  const box = el("#selectedGroupMembers");
  box.innerHTML = [...state.groupMemberChoices.values()].map((user) => `<span class="member-chip"><span class="avatar">${avatar(user)}</span><span><strong>${label(user)}</strong><small>${escapeHtml(user.email)}</small></span><button type="button" data-member-id="${escapeHtml(user.id)}" aria-label="Remove ${label(user)}">&times;</button></span>`).join("");
  box.querySelectorAll("button[data-member-id]").forEach((button) => button.addEventListener("click", () => {
    state.groupMemberChoices.delete(button.dataset.memberId); renderGroupMemberChoices(); searchGroupContacts();
  }));
}
function resetGroupMemberPicker() {
  clearTimeout(groupSearchTimer); groupSearchVersion += 1; state.groupMemberChoices.clear();
  el("#groupContactSearch").value = ""; el("#groupContactResults").innerHTML = ""; renderGroupMemberChoices();
}
async function searchGroupContacts() {
  const query = el("#groupContactSearch").value.trim();
  const box = el("#groupContactResults");
  const searchVersion = ++groupSearchVersion;
  if (query.length < 2) { box.innerHTML = ""; return; }
  try {
    const result = await api(`/api/users?q=${encodeURIComponent(query)}`);
    if (searchVersion !== groupSearchVersion) return;
    const users = result.users.filter((user) => !state.groupMemberChoices.has(user.id));
    box.innerHTML = users.map((user) => `<button class="member-search-result" type="button" data-id="${escapeHtml(user.id)}"><span class="avatar">${avatar(user)}</span><span><strong>${label(user)}</strong><small>${escapeHtml(user.email)}</small></span></button>`).join("") || '<small class="no-results">No registered VX contact found yet</small>';
    box.querySelectorAll("button[data-id]").forEach((button) => button.addEventListener("click", () => {
      const user = users.find((item) => item.id === button.dataset.id);
      if (!user) return;
      state.groupMemberChoices.set(user.id, user); el("#groupContactSearch").value = ""; box.innerHTML = ""; renderGroupMemberChoices();
    }));
  } catch (error) { if (searchVersion === groupSearchVersion) showToast(error.message); }
}
el("#shareInvite").addEventListener("click", copyInvite);
el("#groupContactSearch").addEventListener("input", () => { clearTimeout(groupSearchTimer); groupSearchTimer = setTimeout(searchGroupContacts, 200); });
el("#profileButton").addEventListener("click", () => { el("#profileName").value = state.me.name || ""; el("#profileBio").value = state.me.bio || ""; el("#avatarInput").value = ""; openModal("#profileModal"); });
el("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const avatar = await uploadImage(el("#avatarInput").files[0]);
    const result = await api("/api/me", { method: "PUT", json: { name: el("#profileName").value, bio: el("#profileBio").value, ...(avatar ? { avatar } : {}) } });
    state.me = result.user; renderIdentity(); closeModals(); showToast("Profile updated.");
  } catch (error) { showToast(error.message); }
});
el("#newGroup").addEventListener("click", () => { el("#groupForm").reset(); resetGroupMemberPicker(); openModal("#groupModal"); el("#groupName").focus(); });
el("#groupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const members = el("#groupMembers").value.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean);
    const memberIds = [...state.groupMemberChoices.keys()];
    const result = await api("/api/groups", { method: "POST", json: { title: el("#groupName").value, members, memberIds } });
    closeModals(); await refreshChats(); await openChat(groupChat(result.group)); showToast("Group channel created.");
  } catch (error) { showToast(error.message); }
});
function renderStickerPackForm() {
  const select = el("#stickerPackSelect"); if (!select || !state.me) return;
  const selected = select.value;
  const owned = state.stickerPacks.filter((pack) => pack.ownerId === state.me.id);
  select.innerHTML = '<option value="">Create a new pack</option>' + owned.map((pack) => `<option value="${pack.id}">${escapeHtml(pack.title)} (${pack.stickers.length})</option>`).join("");
  if (owned.some((pack) => pack.id === selected)) select.value = selected;
  toggleStickerPackName();
}
function toggleStickerPackName() {
  const isNew = !el("#stickerPackSelect").value;
  el("#stickerPackNameLabel").classList.toggle("hidden", !isNew);
  el("#stickerPackName").classList.toggle("hidden", !isNew);
  el("#stickerPackName").required = isNew;
}
el("#newStickerPack").addEventListener("click", () => { el("#stickerPackForm").reset(); renderStickerPackForm(); openModal("#stickerPackModal"); });
el("#stickerPackSelect").addEventListener("change", toggleStickerPackName);
el("#stickerPackForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = el("#stickerInput").files[0]; if (!file) return showToast("Choose a sticker image.");
  const submit = el("#stickerPackForm button[type=submit]"); submit.disabled = true;
  try {
    let packId = el("#stickerPackSelect").value;
    if (!packId) {
      const created = await api("/api/sticker-packs", { method: "POST", json: { title: el("#stickerPackName").value } });
      packId = created.pack.id;
    }
    const attachment = await uploadImage(file);
    await api(`/api/sticker-packs/${encodeURIComponent(packId)}/stickers`, { method: "POST", json: { attachment, emoji: el("#stickerEmoji").value } });
    await refreshStickerPacks(); el("#stickerInput").value = ""; el("#stickerEmoji").value = ""; el("#stickerPackSelect").value = packId; toggleStickerPackName(); showToast("Sticker saved to your pack.");
  } catch (error) { showToast(error.message); } finally { submit.disabled = false; }
});

async function addGroupMember() {
  const email = window.prompt("VX e-mail to add"); if (!email || !state.selected || state.selected.type !== "group") return;
  try {
    const result = await api(`/api/groups/${encodeURIComponent(state.selected.group.id)}/members`, { method: "POST", json: { email } });
    state.selected = groupChat(result.group); renderChatHeader(); await refreshChats(); showToast("Member added.");
  } catch (error) { showToast(error.message); }
}

async function poll() {
  if (!state.token) return;
  try {
    const signals = await api("/api/signals"); for (const signal of signals.signals) await handleSignal(signal);
    await refreshChats(); if (state.selected) { renderChatHeader(); await refreshMessages(); }
  } catch (error) { if (state.token) console.warn(error.message); }
}
async function sendSignal(type, payload, peer = selectedPeer()) {
  if (!peer) throw new Error("Select a direct conversation first.");
  return api("/api/signals", { method: "POST", json: { to: peer.id, type, payload } });
}
async function makePeer(kind) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" });
  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
  state.call.localStream = stream; state.call.pc = pc; el("#localVideo").srcObject = stream;
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.ontrack = (event) => { el("#remoteVideo").srcObject = event.streams[0]; };
  pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal("ice-candidate", { callId: state.call.id, candidate }, state.call.peer).catch(() => {}); };
  pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) endCall(false); };
  for (const candidate of state.pendingCandidates.get(state.call.id) || []) await pc.addIceCandidate(candidate).catch(() => {});
  state.pendingCandidates.delete(state.call.id);
}
function revealCall(kind, peer, suffix = "Connecting") { el("#callOverlay").classList.remove("hidden"); el("#callTitle").textContent = `${suffix} ${kind} call · ${peer.name}`; el("#callDetail").textContent = "WebRTC · DTLS-SRTP / ECDH"; }
async function startCall(kind) {
  if (state.config.torOnly) return showToast("Calls are disabled in Tor-only mode to avoid non-Tor WebRTC media paths.");
  const peer = selectedPeer();
  if (!peer) return showToast("Calls are available in direct conversations.");
  if (!navigator.mediaDevices || !window.RTCPeerConnection) return showToast("This browser does not support WebRTC calls.");
  if (state.call) return showToast("A call is already active.");
  try {
    state.call = { id: crypto.randomUUID(), kind, peer }; revealCall(kind, peer, "Calling"); await makePeer(kind);
    const offer = await state.call.pc.createOffer(); await state.call.pc.setLocalDescription(offer); await sendSignal("call-offer", { callId: state.call.id, kind, offer }, peer);
  } catch (error) { showToast(`Call could not start: ${error.message}`); endCall(false); }
}
async function handleSignal(signal) {
  const payload = signal.payload || {};
  if (signal.type === "ice-candidate" && payload.candidate) {
    if (state.call?.id === payload.callId && state.call.pc) await state.call.pc.addIceCandidate(payload.candidate).catch(() => {});
    else { const queue = state.pendingCandidates.get(payload.callId) || []; queue.push(payload.candidate); state.pendingCandidates.set(payload.callId, queue); }
    return;
  }
  if (signal.type === "call-offer") {
    const peer = signal.fromUser || state.chats.find((chat) => chat.type === "direct" && chat.user.id === signal.from)?.user || { id: signal.from, name: "VX contact", email: "" };
    if (state.call) { await sendSignal("call-hangup", { callId: payload.callId }, peer); return; }
    const accept = window.confirm(`${peer.name} is calling (${payload.kind}). Accept?`);
    if (!accept) { await sendSignal("call-hangup", { callId: payload.callId }, peer); return; }
    try {
      state.call = { id: payload.callId, kind: payload.kind, peer }; revealCall(payload.kind, peer, "Encrypted"); await makePeer(payload.kind); await state.call.pc.setRemoteDescription(payload.offer);
      const answer = await state.call.pc.createAnswer(); await state.call.pc.setLocalDescription(answer); await sendSignal("call-answer", { callId: payload.callId, answer }, peer);
    } catch (error) { showToast(`Call could not connect: ${error.message}`); endCall(true); }
    return;
  }
  if (signal.type === "call-answer" && state.call?.id === payload.callId) { await state.call.pc.setRemoteDescription(payload.answer).catch(() => showToast("Could not establish secure call.")); el("#callTitle").textContent = `Encrypted ${state.call.kind} call · ${state.call.peer.name}`; return; }
  if (signal.type === "call-hangup" && state.call?.id === payload.callId) { showToast("Call ended."); endCall(false); }
}
function endCall(notifyPeer = true) {
  const call = state.call; if (!call) return; state.call = null;
  if (notifyPeer) sendSignal("call-hangup", { callId: call.id }, call.peer).catch(() => {});
  call.pc?.close(); call.localStream?.getTracks().forEach((track) => track.stop()); el("#localVideo").srcObject = null; el("#remoteVideo").srcObject = null; el("#callOverlay").classList.add("hidden");
}
el("#hangup").addEventListener("click", () => endCall(true));
if (state.token) enterApp();
