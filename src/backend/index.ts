// Backend half of Tavern Helper. Implements the data operations that Lumiverse only exposes to the backend.
// Protocol: frontend -> { type:'rpc', id, method, args }   backend -> { type:'rpc_result', id, ok, value|error }
//           backend -> { type:'gen_token'|'gen_reasoning'|'gen_done', id, ... } for streamed generation.

declare const spindle: import('lumiverse-spindle-types').SpindleAPI;
const S = spindle as any;

type VarOption = {
  type: 'chat' | 'preset' | 'global' | 'character' | 'message' | 'script' | 'extension';
  chatId?: string | null;
  characterId?: string | null;
  messageId?: string | null;
  script_id?: string;
  extension_id?: string;
};

const VARS_KEY = '__th_vars'; // whole nested object per scope, stored as one JSON string so types round-trip exactly

const send = (userId: string, msg: unknown) => spindle.sendToFrontend(msg as any, userId);
const aborts = new Map<string, AbortController>();

function safeName(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function readJsonString(raw: string): Promise<Record<string, any>> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function readVars(o: VarOption, userId: string): Promise<Record<string, any>> {
  switch (o.type) {
    case 'chat':
      if (!o.chatId) return {};
      return readJsonString(await spindle.variables.local.get(o.chatId, VARS_KEY));
    case 'global':
      return readJsonString(await spindle.variables.global.get(VARS_KEY, userId));
    case 'character':
      return S.storage.getJson(`vars/character/${safeName(o.characterId ?? 'none')}.json`, { fallback: {} });
    case 'preset':
      return S.storage.getJson('vars/preset.json', { fallback: {} });
    case 'script':
      return S.storage.getJson(`vars/script/${safeName(o.script_id ?? 'none')}.json`, { fallback: {} });
    case 'extension':
      return S.storage.getJson(`vars/extension/${safeName(o.extension_id ?? 'none')}.json`, { fallback: {} });
    case 'message': {
      const all = await S.storage.getJson(`vars/message/${safeName(o.chatId ?? 'none')}.json`, { fallback: {} });
      return all[o.messageId ?? ''] ?? {};
    }
  }
}

async function writeVars(o: VarOption, value: Record<string, any>, userId: string): Promise<void> {
  const json = JSON.stringify(value);
  switch (o.type) {
    case 'chat':
      if (!o.chatId) throw new Error('No active chat');
      return spindle.variables.local.set(o.chatId, VARS_KEY, json);
    case 'global':
      return spindle.variables.global.set(VARS_KEY, json, userId);
    case 'character':
      return S.storage.setJson(`vars/character/${safeName(o.characterId ?? 'none')}.json`, value);
    case 'preset':
      return S.storage.setJson('vars/preset.json', value);
    case 'script':
      return S.storage.setJson(`vars/script/${safeName(o.script_id ?? 'none')}.json`, value);
    case 'extension':
      return S.storage.setJson(`vars/extension/${safeName(o.extension_id ?? 'none')}.json`, value);
    case 'message': {
      const path = `vars/message/${safeName(o.chatId ?? 'none')}.json`;
      const all = await S.storage.getJson(path, { fallback: {} });
      all[o.messageId ?? ''] = value;
      return S.storage.setJson(path, all);
    }
  }
}

function toLlmMessages(input: any): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  return (input ?? []).map((m: any) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) }));
}

async function runGeneration(a: any, userId: string): Promise<string> {
  const { id, kind, messages, parameters, connection_id, stream } = a;
  const ac = new AbortController();
  aborts.set(id, ac);
  const req: any = {
    type: kind === 'raw' ? 'raw' : 'quiet',
    messages: toLlmMessages(messages),
    parameters,
    connection_id,
    signal: ac.signal,
  };
  try {
    if (!stream) {
      const res: any = await (kind === 'raw' ? S.generate.raw(req) : S.generate.quiet(req));
      return res?.content ?? '';
    }
    let full = '';
    const gen = kind === 'raw' ? S.generate.rawStream(req) : S.generate.quietStream(req);
    for await (const chunk of gen) {
      if (chunk.type === 'token') {
        full += chunk.token;
        send(userId, { type: 'gen_token', id, token: chunk.token, full });
      } else if (chunk.type === 'reasoning') {
        send(userId, { type: 'gen_reasoning', id, token: chunk.token });
      } else if (chunk.type === 'done') {
        full = chunk.content ?? full;
      }
    }
    return full;
  } finally {
    aborts.delete(id);
  }
}

const methods: Record<string, (args: any, userId: string) => Promise<unknown>> = {
  async ping() {
    return { t: Date.now() };
  },
  async 'vars.read'(a: VarOption, userId) {
    return readVars(a, userId);
  },
  async 'vars.write'(a: { option: VarOption; value: Record<string, any> }, userId) {
    await writeVars(a.option, a.value, userId);
    return true;
  },
  async 'vars.snapshot'(a: { chatId: string | null; characterId: string | null }, userId) {
    const [chat, global, character, preset] = await Promise.all([
      readVars({ type: 'chat', chatId: a.chatId }, userId),
      readVars({ type: 'global' }, userId),
      readVars({ type: 'character', characterId: a.characterId }, userId),
      readVars({ type: 'preset' }, userId),
    ]);
    return { chat, global, character, preset };
  },

  async 'chat.create'(a: { chatId: string; messages: Array<{ role: string; content: string; metadata?: any }> }) {
    const ids: string[] = [];
    for (const m of a.messages) {
      const r = await S.chat.appendMessage(a.chatId, { role: m.role, content: m.content, metadata: m.metadata });
      ids.push(r.id);
    }
    return ids;
  },
  async 'chat.update'(a: { chatId: string; updates: Array<{ messageId: string; patch: any; hidden?: boolean }> }) {
    for (const u of a.updates) {
      if (u.patch && Object.keys(u.patch).length) await S.chat.updateMessage(a.chatId, u.messageId, u.patch);
      if (typeof u.hidden === 'boolean') await S.chat.setMessageHidden(a.chatId, u.messageId, u.hidden);
    }
    return true;
  },
  async 'chat.delete'(a: { chatId: string; messageIds: string[] }) {
    for (const id of a.messageIds) await S.chat.deleteMessage(a.chatId, id);
    return true;
  },

  async 'gen.run'(a, userId) {
    return runGeneration(a, userId);
  },
  async 'gen.stop'(a: { id?: string }) {
    if (a.id) aborts.get(a.id)?.abort();
    else for (const ac of aborts.values()) ac.abort();
    return true;
  },
};

spindle.onFrontendMessage(async (payload: any, userId: string) => {
  if (!payload || payload.type !== 'rpc') return;
  const { id, method, args } = payload;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    send(userId, { type: 'rpc_result', id, ok: true, value: await fn(args, userId) });
  } catch (e: any) {
    send(userId, { type: 'rpc_result', id, ok: false, error: String(e?.message ?? e) });
  }
});

spindle.log?.info?.('[tavern_helper] backend ready');
