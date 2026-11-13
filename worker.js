/*
 * Bale Dynamic Menu Bot
 * Cloudflare Worker + Workers KV binding: DB
 *
 * Required:
 *   Secret: BALE_TOKEN
 *   KV binding: DB
 *   MAIN_ADMIN_ID is fixed below.
 *
 * Deploy, then open /setup once to register the webhook.
 */

const MAIN_ADMIN_ID = 402413224;
// توکن ربات بله را فقط بین کوتیشن‌ها وارد کن.
const BALE_TOKEN = "526770547:1WgILUabOXM7Uy1E8pmPtNfONoojSW4_4IY";
const API_BASE = "https://tapi.bale.ai/bot";
const CACHE_SECONDS = 10;

const K = {
  user: id => `user:${id}`,
  status: id => `status:${id}`,       // pending | approved | rejected
  blocked: id => `blocked:${id}`,
  menu: "menu:tree",
  state: id => `state:${id}`,
  users: "users:index",
  request: id => `request:${id}`
};

export default {
  async fetch(request, env) {
    if (!env.DB || !BALE_TOKEN || BALE_TOKEN === "PASTE_YOUR_BALE_BOT_TOKEN_HERE") {
      return new Response("Missing DB binding or bot token in code", { status: 500 });
    }
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("OK");
    if (url.pathname === "/setup") {
      const hook = `${url.origin}/webhook`;
      const result = await api(env, "setWebhook", { url: hook });
      return json({ webhook: hook, result });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("OK");
    }
    return new Response("Bale Dynamic Menu Bot");
  }
};

function json(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function api(env, method, body) {
  const res = await fetch(`${API_BASE}${BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.log("Bale API error", method, res.status, data);
  return data;
}

async function sendText(env, chat_id, text, extra = {}) {
  return api(env, "sendMessage", { chat_id, text, ...extra });
}
async function answerCallback(env, callback_query_id, text = "") {
  return api(env, "answerCallbackQuery", {
    callback_query_id,
    ...(text ? { text } : {})
  });
}
async function editText(env, chat_id, message_id, text, extra = {}) {
  return api(env, "editMessageText", {
    chat_id, message_id, text, ...extra
  });
}

async function getJSON(db, key, fallback) {
  const value = await db.get(key, "json");
  return value ?? fallback;
}
async function putJSON(db, key, value) {
  await db.put(key, JSON.stringify(value));
}
async function getState(db, id) {
  return (await getJSON(db, K.state(id), {})) || {};
}
async function setState(db, id, state) {
  await putJSON(db, K.state(id), state);
}
async function addUserIndex(db, id) {
  // A single compact index is acceptable for small/medium bots; profile writes are separate.
  const ids = await getJSON(db, K.users, []);
  if (!ids.includes(String(id))) {
    ids.push(String(id));
    await putJSON(db, K.users, ids);
  }
}

function isPrivate(chat) {
  return chat && chat.type === "private";
}
function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "بدون نام";
}
function userInfo(user) {
  return {
    id: String(user.id),
    username: user.username || "",
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    display_name: fullName(user),
    updated_at: Date.now()
  };
}

async function handleUpdate(update, env) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chat = cq.message?.chat;
    // Ignore callbacks originating outside private chats.
    if (!isPrivate(chat)) return;
    await handleCallback(cq, env);
    return;
  }

  const msg = update.message;
  if (!msg || !isPrivate(msg.chat) || !msg.from) return; // Never respond in groups/channels.
  const id = String(msg.from.id);
  const text = (msg.text || "").trim();

  await putJSON(env.DB, K.user(id), userInfo(msg.from));
  await addUserIndex(env.DB, id);

  if (id === String(MAIN_ADMIN_ID)) {
    await handleAdminMessage(msg, env);
    return;
  }

  if (await env.DB.get(K.blocked(id))) return;

  const status = await env.DB.get(K.status(id));
  if (text === "/start" || text.startsWith("/start ")) {
    if (status === "approved") {
      await showMainMenu(env, id);
      return;
    }
    if (status === "pending") return; // Do not reply to the user; don't spam admin.
    await env.DB.put(K.status(id), "pending");
    await notifyAdminRequest(env, msg.from);
    return; // User receives absolutely no message.
  }

  // No replies or menu access before admin approval.
  if (status !== "approved") return;

  await handleApprovedUserMessage(msg, env);
}

async function notifyAdminRequest(env, user) {
  const id = String(user.id);
  const name = fullName(user);
  const username = user.username ? `@${user.username}` : "ندارد";
  const text =
    "🔔 درخواست دسترسی جدید\n\n" +
    `👤 نام اکانت: ${name}\n` +
    `🆔 آیدی کاربری: ${username}\n` +
    `🔢 شناسه عددی: ${id}\n\n` +
    "اجازه استفاده از ربات داده شود؟";
  await sendText(env, String(MAIN_ADMIN_ID), text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ آره، اجازه بده", callback_data: `approve:${id}` },
        { text: "❌ نه، رد کن", callback_data: `reject:${id}` }
      ]]
    }
  });
}

async function handleCallback(cq, env) {
  const adminId = String(cq.from.id);
  const data = cq.data || "";
  const chatId = String(cq.message.chat.id);
  const messageId = cq.message.message_id;

  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    if (adminId !== String(MAIN_ADMIN_ID)) {
      await answerCallback(env, cq.id, "فقط ادمین اصلی اجازه این کار را دارد.");
      return;
    }
    const [action, target] = data.split(":");
    if (await env.DB.get(K.blocked(target))) {
      await answerCallback(env, cq.id, "این کاربر مسدود است.");
      return;
    }
    if (action === "approve") {
      await env.DB.put(K.status(target), "approved");
      await answerCallback(env, cq.id, "دسترسی کاربر تأیید شد.");
      await editText(env, chatId, messageId,
        `✅ درخواست کاربر ${target} تأیید شد.`);
      await showMainMenu(env, target);
    } else {
      await env.DB.put(K.status(target), "rejected");
      await answerCallback(env, cq.id, "درخواست رد شد.");
      await editText(env, chatId, messageId,
        `❌ درخواست کاربر ${target} رد شد.`);
      // Deliberately do not message the rejected user.
    }
    return;
  }

  if (adminId === String(MAIN_ADMIN_ID)) {
    if (data.startsWith("block:")) {
      const target = data.slice(6);
      await env.DB.put(K.blocked(target), "1");
      await env.DB.delete(K.status(target));
      await answerCallback(env, cq.id, "کاربر مسدود شد.");
      await editText(env, chatId, messageId, `⛔ کاربر ${target} مسدود شد.`);
      return;
    }
  }

  if (await env.DB.get(K.blocked(adminId))) return;
  if (await env.DB.get(K.status(adminId)) !== "approved" && adminId !== String(MAIN_ADMIN_ID)) return;

  if (data.startsWith("node:")) {
    const nodeId = data.slice(5);
    const tree = await getJSON(env.DB, K.menu, []);
    const node = findNode(tree, nodeId);
    if (!node) {
      await answerCallback(env, cq.id, "این گزینه دیگر وجود ندارد.");
      return;
    }
    await answerCallback(env, cq.id);
    await showNode(env, adminId, node);
    return;
  }
  if (data === "home") {
    await answerCallback(env, cq.id);
    await showMainMenu(env, adminId);
    return;
  }
  if (data === "admin") {
    if (adminId !== String(MAIN_ADMIN_ID)) return;
    await answerCallback(env, cq.id);
    await showAdminPanel(env, adminId);
  }
}

async function showMainMenu(env, id) {
  const tree = await getJSON(env.DB, K.menu, []);
  const rows = tree.map(n => [{ text: n.title, callback_data: `node:${n.id}` }]);
  if (String(id) === String(MAIN_ADMIN_ID)) {
    rows.push([{ text: "⚙️ پنل مدیریت", callback_data: "admin" }]);
  }
  if (!rows.length) {
    if (String(id) === String(MAIN_ADMIN_ID)) {
      await sendText(env, id, "هنوز دکمه‌ای ساخته نشده است.", {
        reply_markup: { inline_keyboard: [[{ text: "⚙️ پنل مدیریت", callback_data: "admin" }]] }
      });
    }
    return;
  }
  await sendText(env, id, "منوی اصلی:", { reply_markup: { inline_keyboard: rows } });
}

async function showNode(env, id, node) {
  if (node.response_type === "text" && node.response) {
    await sendText(env, id, node.response);
  } else if (node.response_type === "photo" && node.file_id) {
    await api(env, "sendPhoto", { chat_id: id, photo: node.file_id, caption: node.caption || "" });
  } else if (node.response_type === "video" && node.file_id) {
    await api(env, "sendVideo", { chat_id: id, video: node.file_id, caption: node.caption || "" });
  }
  const rows = (node.children || []).map(child => [
    { text: child.title, callback_data: `node:${child.id}` }
  ]);
  rows.push([{ text: "↩️ منوی اصلی", callback_data: "home" }]);
  await sendText(env, id, node.children?.length ? "یکی از گزینه‌ها را انتخاب کن:" : " ", {
    reply_markup: { inline_keyboard: rows }
  });
}

function findNode(nodes, id) {
  for (const node of nodes || []) {
    if (String(node.id) === String(id)) return node;
    const found = findNode(node.children || [], id);
    if (found) return found;
  }
  return null;
}

async function handleApprovedUserMessage(msg, env) {
  const id = String(msg.from.id);
  if (msg.text === "/start") return showMainMenu(env, id);
  // Menu navigation is handled through inline buttons. Ignore arbitrary user messages.
}

async function showAdminPanel(env, id) {
  await sendText(env, id,
    "⚙️ پنل مدیریت\n\nبرای مدیریت دکمه‌ها از دستورهای زیر استفاده کن:\n" +
    "/addbutton عنوان دکمه\n" +
    "/listbuttons\n" +
    "/users\n" +
    "/block شناسه_عددی\n" +
    "/unblock شناسه_عددی\n\n" +
    "برای افزودن زیرمجموعه: /addchild شناسه_دکمه عنوان\n" +
    "برای تعیین پاسخ متنی: /settext شناسه_دکمه متن\n" +
    "برای حذف دکمه: /delbutton شناسه_دکمه\n" +
    "برای ارسال پیام شخصی: /send شناسه_عددی متن\n" +
    "برای ارسال پیام همگانی: /broadcast متن\n\n" +
    "برای پاسخ تصویری/ویدیویی، عکس یا ویدیو را همراه کپشن ارسال کن و در کپشن بنویس:\n" +
    "/setphoto شناسه_دکمه یا /setvideo شناسه_دکمه"
  );
}

async function handleAdminMessage(msg, env) {
  const id = String(MAIN_ADMIN_ID);
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/admin") return showAdminPanel(env, id);

  if (text.startsWith("/addbutton ")) {
    const title = text.slice(11).trim();
    if (!title) return sendText(env, id, "عنوان دکمه را وارد کن.");
    const tree = await getJSON(env.DB, K.menu, []);
    tree.push({ id: crypto.randomUUID().slice(0, 8), title, children: [], response_type: "none" });
    await putJSON(env.DB, K.menu, tree);
    return sendText(env, id, "✅ دکمه اضافه شد.");
  }

  if (text === "/listbuttons") {
    const tree = await getJSON(env.DB, K.menu, []);
    if (!tree.length) return sendText(env, id, "لیست دکمه‌ها خالی است.");
    return sendText(env, id, tree.map(n => `${n.id} — ${n.title}`).join("\n"));
  }

  if (text.startsWith("/addchild ")) {
    const parts = text.split(" ");
    const parentId = parts[1];
    const title = parts.slice(2).join(" ").trim();
    const tree = await getJSON(env.DB, K.menu, []);
    const parent = findNode(tree, parentId);
    if (!parent || !title) return sendText(env, id, "شناسه یا عنوان نامعتبر است.");
    parent.children ||= [];
    parent.children.push({ id: crypto.randomUUID().slice(0, 8), title, children: [], response_type: "none" });
    await putJSON(env.DB, K.menu, tree);
    return sendText(env, id, "✅ زیرمجموعه اضافه شد.");
  }

  if (text.startsWith("/settext ")) {
    const parts = text.split(" ");
    const nodeId = parts[1];
    const response = parts.slice(2).join(" ").trim();
    const tree = await getJSON(env.DB, K.menu, []);
    const node = findNode(tree, nodeId);
    if (!node || !response) return sendText(env, id, "شناسه یا متن نامعتبر است.");
    node.response_type = "text"; node.response = response;
    await putJSON(env.DB, K.menu, tree);
    return sendText(env, id, "✅ پاسخ متنی ذخیره شد.");
  }

  if (text.startsWith("/delbutton ")) {
    const nodeId = text.split(/\s+/)[1];
    const tree = await getJSON(env.DB, K.menu, []);
    const removed = removeNode(tree, nodeId);
    if (!removed) return sendText(env, id, "دکمه پیدا نشد.");
    await putJSON(env.DB, K.menu, tree);
    return sendText(env, id, "🗑 دکمه حذف شد.");
  }

  if (msg.photo?.length || msg.video) {
    const caption = (msg.caption || "").trim();
    const match = caption.match(/^\/(setphoto|setvideo)\s+([a-zA-Z0-9_-]+)/);
    if (!match) return sendText(env, id, "برای ذخیره رسانه، کپشن را با /setphoto شناسه یا /setvideo شناسه شروع کن.");
    const tree = await getJSON(env.DB, K.menu, []);
    const node = findNode(tree, match[2]);
    if (!node) return sendText(env, id, "دکمه پیدا نشد.");
    if (msg.photo?.length) {
      node.response_type = "photo";
      node.file_id = msg.photo[msg.photo.length - 1].file_id;
    } else {
      node.response_type = "video";
      node.file_id = msg.video.file_id;
    }
    node.caption = caption.replace(match[0], "").trim();
    await putJSON(env.DB, K.menu, tree);
    return sendText(env, id, "✅ رسانه ذخیره شد.");
  }

  if (text.startsWith("/users")) {
    const ids = await getJSON(env.DB, K.users, []);
    const page = ids.slice(0, 100);
    const lines = [];
    for (const uid of page) {
      const u = await getJSON(env.DB, K.user(uid), {});
      lines.push(`${uid} | ${u.display_name || "—"} | ${u.username ? "@" + u.username : "بدون آیدی"} | ${await env.DB.get(K.status(uid)) || "بدون وضعیت"}${await env.DB.get(K.blocked(uid)) ? " | مسدود" : ""}`);
    }
    return sendText(env, id, `تعداد ثبت‌شده: ${ids.length}\n` + (lines.join("\n") || "کاربری ثبت نشده است."));
  }

  if (text.startsWith("/block ")) {
    const target = text.split(/\s+/)[1];
    if (!target) return sendText(env, id, "شناسه عددی کاربر را وارد کن.");
    await env.DB.put(K.blocked(target), "1");
    await env.DB.delete(K.status(target));
    return sendText(env, id, `⛔ کاربر ${target} مسدود شد.`);
  }

  if (text.startsWith("/unblock ")) {
    const target = text.split(/\s+/)[1];
    if (!target) return sendText(env, id, "شناسه عددی کاربر را وارد کن.");
    await env.DB.delete(K.blocked(target));
    await env.DB.put(K.status(target), "rejected");
    return sendText(env, id, `✅ مسدودیت ${target} برداشته شد. کاربر با /start دوباره درخواست دسترسی می‌دهد.`);
  }

  if (text.startsWith("/send ")) {
    const parts = text.split(" ");
    const target = parts[1];
    const body = parts.slice(2).join(" ").trim();
    if (!target || !body) return sendText(env, id, "فرمت: /send شناسه متن");
    if (await env.DB.get(K.blocked(target))) return sendText(env, id, "این کاربر مسدود است.");
    return sendText(env, target, body).then(() => sendText(env, id, "پیام ارسال شد."));
  }

  if (text.startsWith("/broadcast ")) {
    const body = text.slice(11).trim();
    const ids = await getJSON(env.DB, K.users, []);
    let sent = 0, failed = 0;
    for (const uid of ids) {
      if (await env.DB.get(K.status(uid)) !== "approved" || await env.DB.get(K.blocked(uid))) continue;
      const result = await sendText(env, uid, body);
      if (result?.ok === false) failed++; else sent++;
    }
    return sendText(env, id, `پایان ارسال.\nموفق: ${sent}\nناموفق: ${failed}`);
  }

  return sendText(env, id, "دستور شناخته نشد. برای دیدن راهنما /admin را بفرست.");
}

function removeNode(nodes, id) {
  const index = nodes.findIndex(n => String(n.id) === String(id));
  if (index >= 0) { nodes.splice(index, 1); return true; }
  for (const node of nodes) if (removeNode(node.children || [], id)) return true;
  return false;
     }
