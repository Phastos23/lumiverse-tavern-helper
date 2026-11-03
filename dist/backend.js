// src/backend/index.ts
var S = spindle;
var VARS_KEY = "__th_vars";
var send = (userId, msg) => spindle.sendToFrontend(msg, userId);
var aborts = /* @__PURE__ */ new Map();
function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
async function readJsonString(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
async function readVars(o, userId) {
  switch (o.type) {
    case "chat":
      if (!o.chatId) return {};
      return readJsonString(await spindle.variables.local.get(o.chatId, VARS_KEY));
    case "global":
      return readJsonString(await spindle.variables.global.get(VARS_KEY, userId));
    case "character":
      return S.storage.getJson(`vars/character/${safeName(o.characterId ?? "none")}.json`, { fallback: {} });
    case "preset":
      return S.storage.getJson("vars/preset.json", { fallback: {} });
    case "script":
      return S.storage.getJson(`vars/script/${safeName(o.script_id ?? "none")}.json`, { fallback: {} });
    case "extension":
      return S.storage.getJson(`vars/extension/${safeName(o.extension_id ?? "none")}.json`, { fallback: {} });
    case "message": {
      const all = await S.storage.getJson(`vars/message/${safeName(o.chatId ?? "none")}.json`, { fallback: {} });
      return all[o.messageId ?? ""] ?? {};
    }
  }
}
async function writeVars(o, value, userId) {
  const json = JSON.stringify(value);
  switch (o.type) {
    case "chat":
      if (!o.chatId) throw new Error("No active chat");
      return spindle.variables.local.set(o.chatId, VARS_KEY, json);
    case "global":
      return spindle.variables.global.set(VARS_KEY, json, userId);
    case "character":
      return S.storage.setJson(`vars/character/${safeName(o.characterId ?? "none")}.json`, value);
    case "preset":
      return S.storage.setJson("vars/preset.json", value);
    case "script":
      return S.storage.setJson(`vars/script/${safeName(o.script_id ?? "none")}.json`, value);
    case "extension":
      return S.storage.setJson(`vars/extension/${safeName(o.extension_id ?? "none")}.json`, value);
    case "message": {
      const path = `vars/message/${safeName(o.chatId ?? "none")}.json`;
      const all = await S.storage.getJson(path, { fallback: {} });
      all[o.messageId ?? ""] = value;
      return S.storage.setJson(path, all);
    }
  }
}
function toLlmMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return (input ?? []).map((m) => ({ role: m.role, content: m.content, ...m.name ? { name: m.name } : {} }));
}
async function runGeneration(a, userId) {
  const { id, kind, messages, parameters, connection_id, stream } = a;
  const ac = new AbortController();
  aborts.set(id, ac);
  const req = {
    type: kind === "raw" ? "raw" : "quiet",
    messages: toLlmMessages(messages),
    parameters,
    connection_id,
    signal: ac.signal
  };
  try {
    if (!stream) {
      const res = await (kind === "raw" ? S.generate.raw(req) : S.generate.quiet(req));
      return res?.content ?? "";
    }
    let full = "";
    const gen = kind === "raw" ? S.generate.rawStream(req) : S.generate.quietStream(req);
    for await (const chunk of gen) {
      if (chunk.type === "token") {
        full += chunk.token;
        send(userId, { type: "gen_token", id, token: chunk.token, full });
      } else if (chunk.type === "reasoning") {
        send(userId, { type: "gen_reasoning", id, token: chunk.token });
      } else if (chunk.type === "done") {
        full = chunk.content ?? full;
      }
    }
    return full;
  } finally {
    aborts.delete(id);
  }
}
var methods = {
  async ping() {
    return { t: Date.now() };
  },
  async "vars.read"(a, userId) {
    return readVars(a, userId);
  },
  async "vars.write"(a, userId) {
    await writeVars(a.option, a.value, userId);
    return true;
  },
  async "vars.snapshot"(a, userId) {
    const [chat, global, character, preset] = await Promise.all([
      readVars({ type: "chat", chatId: a.chatId }, userId),
      readVars({ type: "global" }, userId),
      readVars({ type: "character", characterId: a.characterId }, userId),
      readVars({ type: "preset" }, userId)
    ]);
    return { chat, global, character, preset };
  },
  // ------------------------------------------------------------- world books
  async "wb.listBooks"() {
    const out = [];
    for (let offset = 0; ; offset += 200) {
      const page = await S.world_books.list({ limit: 200, offset });
      out.push(...page.data.map((b) => ({ id: b.id, name: b.name })));
      if (out.length >= page.total || page.data.length === 0) break;
    }
    return out;
  },
  async "wb.listEntries"(a) {
    const out = [];
    for (let offset = 0; ; offset += 200) {
      const page = await S.world_books.entries.list(a.bookId, { limit: 200, offset });
      out.push(...page.data);
      if (out.length >= page.total || page.data.length === 0) break;
    }
    return out;
  },
  async "wb.createBook"(a) {
    const b = await S.world_books.create({ name: a.name });
    return { id: b.id, name: b.name };
  },
  async "wb.deleteBook"(a) {
    return S.world_books.delete(a.bookId);
  },
  async "wb.createEntry"(a) {
    return S.world_books.entries.create(a.bookId, a.data);
  },
  async "wb.updateEntry"(a) {
    return S.world_books.entries.update(a.entryId, a.data);
  },
  async "wb.deleteEntry"(a) {
    return S.world_books.entries.delete(a.entryId);
  },
  async "wb.getGlobal"() {
    return S.world_books.getGlobal();
  },
  async "wb.setGlobal"(a) {
    return S.world_books.setGlobal(a.ids);
  },
  async "wb.getCharacterBooks"(a) {
    const ch = await S.characters.get(a.characterId);
    return ch?.world_book_ids ?? [];
  },
  async "wb.setCharacterBooks"(a) {
    await S.characters.update(a.characterId, { world_book_ids: a.ids });
    return true;
  },
  // Full chat history (the frontend API can only read the last 200 messages).
  async "chat.list"(a) {
    const list = await S.chat.getMessages(a.chatId);
    return list.map((m, i) => ({
      id: m.id,
      index: typeof m.index_in_chat === "number" ? m.index_in_chat : i,
      name: m.name ?? "",
      is_user: m.role ? m.role === "user" : !!m.is_user,
      role: m.role,
      content: m.content ?? "",
      hidden: !!(m.hidden ?? m.extra?.hidden),
      swipe_id: m.swipe_id ?? 0,
      swipes: Array.isArray(m.swipes) ? m.swipes : [],
      extra: m.extra ?? {}
    }));
  },
  async "chat.create"(a) {
    const ids = [];
    for (const m of a.messages) {
      const r = await S.chat.appendMessage(a.chatId, { role: m.role, content: m.content, metadata: m.metadata });
      ids.push(r.id);
    }
    return ids;
  },
  async "chat.update"(a) {
    for (const u of a.updates) {
      if (u.patch && Object.keys(u.patch).length) await S.chat.updateMessage(a.chatId, u.messageId, u.patch);
      if (typeof u.hidden === "boolean") await S.chat.setMessageHidden(a.chatId, u.messageId, u.hidden);
    }
    return true;
  },
  async "chat.delete"(a) {
    for (const id of a.messageIds) await S.chat.deleteMessage(a.chatId, id);
    return true;
  },
  async "gen.run"(a, userId) {
    return runGeneration(a, userId);
  },
  async "gen.stop"(a) {
    if (a.id) aborts.get(a.id)?.abort();
    else for (const ac of aborts.values()) ac.abort();
    return true;
  }
};
spindle.onFrontendMessage(async (payload, userId) => {
  if (!payload || payload.type !== "rpc") return;
  const { id, method, args } = payload;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    send(userId, { type: "rpc_result", id, ok: true, value: await fn(args, userId) });
  } catch (e) {
    send(userId, { type: "rpc_result", id, ok: false, error: String(e?.message ?? e) });
  }
});
spindle.log?.info?.("[tavern_helper] backend ready");
