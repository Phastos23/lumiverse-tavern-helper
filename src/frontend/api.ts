import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import _ from 'lodash';
import { EventBus, iframe_events, tavern_events } from './events';
import type { Mirror, MirrorMessage } from './mirror';
import type { Rpc } from './rpc';

export interface Env {
  ctx: SpindleFrontendContext;
  rpc: Rpc;
  mirror: Mirror;
  bus: EventBus;
  log: (level: 'info' | 'warn' | 'error', ...args: unknown[]) => void;
}

type VarOption = {
  type: 'chat' | 'preset' | 'global' | 'character' | 'message' | 'script' | 'extension';
  message_id?: number | 'latest';
  script_id?: string;
  extension_id?: string;
};

/** Caller identity, so script-scoped helpers (getScriptId, events, script variables) know which script is calling. */
export interface Caller {
  owner: string;
  scriptId?: string;
  scriptName?: string;
  iframeName?: string;
  messageId?: number;
}

const toastrLevels = ['info', 'success', 'warning', 'error'] as const;

export function createApi(env: Env) {
  const { ctx, rpc, mirror, bus } = env;
  const generations = new Map<string, { stopped: boolean }>();

  // ---------------------------------------------------------------- variables
  function resolveMessage(option: VarOption, caller?: Caller): MirrorMessage | undefined {
    let id = option.message_id ?? caller?.messageId ?? 'latest';
    if (id === 'latest') id = mirror.lastMessageId;
    return mirror.messageByIndex(id as number);
  }

  function scopeStore(option: VarOption, caller?: Caller): { get(): Record<string, any>; set(v: Record<string, any>): void } {
    const backendOption: any = { type: option.type, chatId: mirror.chatId, characterId: mirror.characterId };
    switch (option.type) {
      case 'chat':
      case 'global':
      case 'character':
      case 'preset':
        return {
          get: () => mirror.vars[option.type as 'chat'],
          set: v => {
            mirror.vars[option.type as 'chat'] = v;
            void mirror.enqueue(() => rpc.call('vars.write', { option: backendOption, value: v }));
          },
        };
      case 'script': {
        const id = option.script_id ?? caller?.scriptId ?? '';
        backendOption.script_id = id;
        return mapStore(mirror.scriptVars, id, backendOption);
      }
      case 'extension': {
        const id = option.extension_id ?? '';
        backendOption.extension_id = id;
        return mapStore(mirror.extensionVars, id, backendOption);
      }
      case 'message': {
        const m = resolveMessage(option, caller);
        backendOption.messageId = m?.id ?? null;
        return mapStore(mirror.messageVars, m?.id ?? '', backendOption);
      }
    }
  }

  function mapStore(map: Map<string, Record<string, any>>, key: string, backendOption: any) {
    return {
      get: () => {
        if (!map.has(key)) {
          map.set(key, {});
          // Lazy load: the first synchronous read returns {} and the real value arrives shortly after.
          void rpc
            .call('vars.read', backendOption)
            .then(v => map.set(key, v ?? {}))
            .catch(() => undefined);
        }
        return map.get(key)!;
      },
      set: (v: Record<string, any>) => {
        map.set(key, v);
        void mirror.enqueue(() => rpc.call('vars.write', { option: backendOption, value: v }));
      },
    };
  }

  const variableFns = (caller?: Caller) => {
    const normalize = (o?: VarOption): VarOption => o ?? { type: 'chat' };
    const getVariables = (option?: VarOption) => _.cloneDeep(scopeStore(normalize(option), caller).get());
    const replaceVariables = (variables: Record<string, any>, option?: VarOption) =>
      scopeStore(normalize(option), caller).set(_.cloneDeep(variables));
    function updateVariablesWith(updater: (v: Record<string, any>) => any, option?: VarOption): any {
      const o = normalize(option);
      const current = getVariables(o);
      const result = updater(current);
      if (result && typeof (result as Promise<any>).then === 'function') {
        return (result as Promise<Record<string, any>>).then(v => (replaceVariables(v, o), getVariables(o)));
      }
      replaceVariables(result, o);
      return getVariables(o);
    }
    const insertOrAssignVariables = (variables: Record<string, any>, option?: VarOption) => {
      const o = normalize(option);
      const merged = _.merge(getVariables(o), _.cloneDeep(variables));
      replaceVariables(merged, o);
      return getVariables(o);
    };
    const insertVariables = (variables: Record<string, any>, option?: VarOption) => {
      const o = normalize(option);
      const merged = _.defaultsDeep(getVariables(o), _.cloneDeep(variables));
      replaceVariables(merged, o);
      return getVariables(o);
    };
    const deleteVariable = (variable_path: string, option?: VarOption) => {
      const o = normalize(option);
      const vars = getVariables(o);
      const occurred = _.has(vars, variable_path);
      _.unset(vars, variable_path);
      if (occurred) replaceVariables(vars, o);
      return { variables: vars, delete_occurred: occurred };
    };
    return { getVariables, replaceVariables, updateVariablesWith, insertOrAssignVariables, insertVariables, deleteVariable };
  };

  // ------------------------------------------------------------ chat messages
  function parseRange(range: string | number): number[] {
    const last = mirror.lastMessageId;
    const fix = (n: number) => (n < 0 ? last + 1 + n : n);
    if (typeof range === 'number') return [fix(range)];
    const m = String(range).trim().match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
    if (!m) throw new Error(`Invalid message range: ${range}`);
    const a = fix(Number(m[1]));
    const b = m[2] !== undefined ? fix(Number(m[2])) : a;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  function toJsrMessage(m: MirrorMessage, swiped: boolean): any {
    if (swiped) {
      return {
        message_id: m.index,
        name: m.name,
        role: m.role,
        is_hidden: m.hidden,
        swipe_id: m.swipe_id,
        swipes: [...m.swipes],
        swipes_data: m.swipes.map(() => ({})),
        swipes_info: m.swipes.map(() => ({})),
      };
    }
    return {
      message_id: m.index,
      name: m.name,
      role: m.role,
      is_hidden: m.hidden,
      message: m.content,
      data: _.cloneDeep(mirror.messageVars.get(m.id) ?? {}),
      extra: _.cloneDeep(m.extra),
    };
  }

  function getChatMessages(
    range: string | number,
    opts: { role?: 'all' | 'system' | 'assistant' | 'user'; hide_state?: 'all' | 'hidden' | 'unhidden'; include_swipes?: boolean } = {},
  ) {
    const { role = 'all', hide_state = 'all', include_swipes = false } = opts;
    return parseRange(range)
      .map(i => mirror.messageByIndex(i))
      .filter((m): m is MirrorMessage => !!m)
      .filter(m => (role === 'all' ? true : m.role === role))
      .filter(m => (hide_state === 'all' ? true : hide_state === 'hidden' ? m.hidden : !m.hidden))
      .map(m => toJsrMessage(m, include_swipes));
  }

  async function setChatMessages(
    chat_messages: Array<{ message_id: number } & Record<string, any>>,
    _opt?: { refresh?: 'none' | 'affected' | 'all' },
  ) {
    if (!mirror.chatId) throw new Error('No active chat');
    const updates: Array<{ messageId: string; patch: any; hidden?: boolean }> = [];
    for (const cm of chat_messages) {
      const m = mirror.messageByIndex(cm.message_id);
      if (!m) {
        env.log('warn', `setChatMessages: message ${cm.message_id} not found`);
        continue;
      }
      const patch: any = {};
      if (typeof cm.message === 'string') patch.content = cm.message;
      if (Array.isArray(cm.swipes)) patch.swipes = cm.swipes;
      if (typeof cm.swipe_id === 'number') patch.swipe_id = cm.swipe_id;
      if (cm.extra && typeof cm.extra === 'object') patch.metadata_patch = cm.extra;
      updates.push({ messageId: m.id, patch, hidden: typeof cm.is_hidden === 'boolean' ? cm.is_hidden : undefined });
      if (cm.data && typeof cm.data === 'object') {
        mirror.messageVars.set(m.id, _.cloneDeep(cm.data));
        void mirror.enqueue(() =>
          rpc.call('vars.write', {
            option: { type: 'message', chatId: mirror.chatId, messageId: m.id },
            value: cm.data,
          }),
        );
      }
    }
    await mirror.flush();
    await rpc.call('chat.update', { chatId: mirror.chatId, updates });
    await mirror.loadMessages();
  }

  async function createChatMessages(
    chat_messages: Array<{ name?: string; role: string; is_hidden?: boolean; message: string; data?: any; extra?: any }>,
    opt: { insert_before?: number | 'end'; insert_at?: number | 'end' } = {},
  ) {
    if (!mirror.chatId) throw new Error('No active chat');
    const at = opt.insert_before ?? opt.insert_at ?? 'end';
    if (at !== 'end') env.log('warn', 'createChatMessages: inserting in the middle is not supported on Lumiverse; appending instead');
    const ids: string[] = await rpc.call('chat.create', {
      chatId: mirror.chatId,
      messages: chat_messages.map(m => ({ role: m.role, content: m.message, metadata: m.extra })),
    });
    const hidden = chat_messages.map((m, i) => (m.is_hidden ? { messageId: ids[i], patch: {}, hidden: true } : null)).filter(Boolean);
    if (hidden.length) await rpc.call('chat.update', { chatId: mirror.chatId, updates: hidden });
    await mirror.loadMessages();
  }

  async function deleteChatMessages(message_ids: number[]) {
    if (!mirror.chatId) throw new Error('No active chat');
    const ids = message_ids.map(i => mirror.messageByIndex(i)?.id).filter((x): x is string => !!x);
    await rpc.call('chat.delete', { chatId: mirror.chatId, messageIds: ids });
    await mirror.loadMessages();
  }

  // --------------------------------------------------------------- generation
  async function buildPrompt(
    ordered: Array<string | { role: string; content: string }> | undefined,
    userInput: string | undefined,
    maxHistory: 'all' | number | undefined,
    includeHistory: boolean,
  ) {
    const ch: any = mirror.characterId ? await (ctx as any).characters?.get?.(mirror.characterId).catch(() => null) : null;
    const sub = (s: string) => substitudeMacros(s ?? '');
    const history = () => {
      let msgs = mirror.messages.filter(m => !m.hidden);
      if (typeof maxHistory === 'number') msgs = msgs.slice(-maxHistory);
      return msgs.map(m => ({ role: m.role, content: m.content }));
    };
    const defaultOrder = [
      'world_info_before', 'persona_description', 'char_description', 'char_personality', 'scenario', 'world_info_after',
      ...(includeHistory ? ['chat_history'] : []), 'user_input',
    ];
    const out: Array<{ role: string; content: string }> = [];
    for (const item of ordered ?? defaultOrder) {
      if (typeof item !== 'string') {
        out.push({ role: item.role, content: sub(item.content) });
        continue;
      }
      switch (item) {
        case 'char_description':
          if (ch?.description) out.push({ role: 'system', content: sub(ch.description) });
          break;
        case 'char_personality':
          if (ch?.personality) out.push({ role: 'system', content: sub(ch.personality) });
          break;
        case 'scenario':
          if (ch?.scenario) out.push({ role: 'system', content: sub(ch.scenario) });
          break;
        case 'chat_history':
          out.push(...history());
          break;
        case 'user_input':
          if (userInput) out.push({ role: 'user', content: userInput });
          break;
        default:
          break; // world info / persona placeholders are not available through the frontend API yet
      }
    }
    return out;
  }

  async function runGen(config: any, raw: boolean) {
    const id: string = config.generation_id ?? rpc.newId();
    generations.set(id, { stopped: false });
    const messages = await buildPrompt(raw ? config.ordered_prompts : undefined, config.user_input, config.max_chat_history, true);
    const stream = !!config.should_stream;
    let off: (() => void) | undefined;
    await bus.emit(iframe_events.GENERATION_STARTED, id);
    if (stream) {
      off = rpc.onPush(p => {
        if (p?.id !== id) return;
        if (p.type === 'gen_token') {
          bus.emitSync(iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, p.token, id);
          bus.emitSync(iframe_events.STREAM_TOKEN_RECEIVED_FULLY, p.full, id);
        }
      });
    }
    try {
      const params: any = {};
      const ov = config.overrides ?? {};
      if (typeof ov.max_context === 'number') params.max_context = ov.max_context;
      if (typeof ov.max_response === 'number') params.max_tokens = ov.max_response;
      const content: string = await rpc.call('gen.run', {
        id,
        kind: raw ? 'raw' : 'quiet',
        messages,
        parameters: Object.keys(params).length ? params : undefined,
        stream,
      });
      await bus.emit(iframe_events.GENERATION_ENDED, content, id);
      return config.should_return_reasoning ? { content, reasoning: '' } : content;
    } finally {
      off?.();
      generations.delete(id);
    }
  }

  // ------------------------------------------------------------------ helpers
  function substitudeMacros(text: string): string {
    return String(text)
      .replace(/\{\{user\}\}/gi, mirror.userName)
      .replace(/\{\{char\}\}/gi, mirror.characterName)
      .replace(/\{\{lastMessageId\}\}/gi, String(mirror.lastMessageId));
  }

  const toast = (level: (typeof toastrLevels)[number]) => (message?: string, title?: string) => {
    env.log(level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'info', `[toastr.${level}]`, title ?? '', message ?? '');
    try {
      const el = document.createElement('div');
      el.textContent = (title ? title + ': ' : '') + (message ?? '');
      el.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:10px 14px;border-radius:8px;max-width:360px;' +
        'font:13px system-ui;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;background:' +
        { info: '#2f6fa8', success: '#2e8b57', warning: '#b8860b', error: '#b03030' }[level];
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    } catch {
      /* ignore */
    }
  };

  /** Functions that don't depend on who is calling. */
  const shared = {
    getChatMessages,
    setChatMessages,
    createChatMessages,
    deleteChatMessages,
    getLastMessageId: () => mirror.lastMessageId,
    getCurrentCharacterName: () => mirror.characterName,
    getCurrentCharacterId: () => mirror.characterId ?? '',
    getCurrentPersonaName: () => mirror.userName,
    getChatHistoryBrief: () => mirror.messages.map(m => ({ message_id: m.index, role: m.role, name: m.name })),
    getTavernHelperVersion: () => '0.1.0-lumiverse',
    getTavernVersion: () => `lumiverse ${(ctx as any).host?.lumiverseVersion ?? ''}`.trim(),
    getTavernHelperExtensionId: () => ctx.manifest?.identifier ?? 'tavern_helper',
    isAdmin: () => true,
    substitudeMacros,
    errorCatched:
      <T extends any[], U>(fn: (...a: T) => U) =>
      (...a: T) => {
        try {
          return fn(...a);
        } catch (e) {
          env.log('error', e);
          toast('error')(String((e as Error)?.message ?? e), 'Script error');
        }
      },
    getCharData: async (name?: string) => {
      const id = mirror.characterId;
      const ch: any = id ? await (ctx as any).characters?.get?.(id) : null;
      return ch ? { name: ch.name, description: ch.description, personality: ch.personality, scenario: ch.scenario, first_mes: ch.first_mes, mes_example: ch.mes_example, tags: ch.tags, extensions: ch.extensions } : null;
    },
    generate: (config: any) => runGen(config ?? {}, false),
    generateRaw: (config: any) => runGen(config ?? {}, true),
    stopGenerationById: (id: string) => {
      const g = generations.get(id);
      if (!g) return false;
      g.stopped = true;
      void rpc.call('gen.stop', { id });
      return true;
    },
    stopAllGeneration: () => {
      const had = generations.size > 0;
      void rpc.call('gen.stop', {});
      return had;
    },
    toastr: Object.fromEntries(toastrLevels.map(l => [l, toast(l)])),
    tavern_events,
    iframe_events,
    waitGlobalInitialized: async (_name: string) => undefined,
    initializeGlobal: (_name: string, _value: unknown) => undefined,
  };

  /** Per-caller functions: events (so listeners are cleaned up with their script), script ids, scoped variables. */
  function bindFor(caller: Caller) {
    const owner = caller.owner;
    return {
      ...variableFns(caller),
      eventOn: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, owner),
      eventOnce: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, owner, { once: true }),
      eventMakeFirst: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, owner, { first: true }),
      eventMakeLast: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, owner),
      eventOnButton: (e: string, fn: (...a: any[]) => any) => void bus.on(e, fn, owner),
      eventEmit: (e: string, ...d: any[]) => bus.emit(e, ...d),
      eventEmitAndWait: (e: string, ...d: any[]) => bus.emit(e, ...d),
      eventRemoveListener: (e: string, fn: (...a: any[]) => any) => bus.off(e, fn),
      eventClearEvent: (e: string) => bus.clearEvent(e),
      eventClearListener: (fn: (...a: any[]) => any) => bus.clearListener(fn),
      eventClearAll: () => bus.clearOwner(owner),
      getScriptId: () => caller.scriptId ?? '',
      getScriptName: () => caller.scriptName ?? '',
      getIframeName: () => caller.iframeName ?? '',
      getButtonEvent: (button_name: string) => `${caller.scriptId ?? ''}_${button_name}`,
      getMessageId: () => caller.messageId ?? -1,
      getCurrentMessageId: () => caller.messageId ?? mirror.lastMessageId,
    };
  }

  /** Wire Lumiverse's events into JSR-style events. */
  function bridgeLumiverseEvents(): () => void {
    const offs: Array<() => void> = [];
    const idx = (messageId?: string) => mirror.messages.find(m => m.id === messageId)?.index ?? mirror.lastMessageId;
    const on = (name: string, fn: (p: any) => void | Promise<void>) => {
      try {
        offs.push(ctx.events.on(name, p => void fn(p as any)));
      } catch (e) {
        env.log('warn', `could not subscribe to ${name}`, e);
      }
    };
    on('MESSAGE_SENT', async p => {
      await mirror.loadMessages();
      await bus.emit(tavern_events.MESSAGE_SENT, idx(p?.message?.id));
    });
    on('MESSAGE_EDITED', async p => {
      await mirror.loadMessages();
      const i = idx(p?.message?.id);
      await bus.emit(tavern_events.MESSAGE_EDITED, i);
      await bus.emit(tavern_events.MESSAGE_UPDATED, i);
    });
    on('MESSAGE_DELETED', async p => {
      const i = idx(p?.messageId);
      await mirror.loadMessages();
      await bus.emit(tavern_events.MESSAGE_DELETED, i);
    });
    on('MESSAGE_SWIPED', async p => {
      await mirror.loadMessages();
      await bus.emit(tavern_events.MESSAGE_SWIPED, idx(p?.message?.id));
    });
    on('CHARACTER_MESSAGE_RENDERED', async p => {
      await mirror.loadMessages();
      const i = idx(p?.messageId);
      await bus.emit(tavern_events.MESSAGE_RECEIVED, i);
      await bus.emit(tavern_events.CHARACTER_MESSAGE_RENDERED, i);
    });
    on('USER_MESSAGE_RENDERED', async p => bus.emit(tavern_events.USER_MESSAGE_RENDERED, idx(p?.messageId)));
    const chatChanged = async (p: any) => {
      await mirror.reload();
      await bus.emit(tavern_events.CHAT_CHANGED, p?.chatId ?? mirror.chatId ?? '');
    };
    on('CHAT_CHANGED', chatChanged);
    on('CHAT_SWITCHED', chatChanged);
    on('GENERATION_STARTED', p => bus.emit(tavern_events.GENERATION_STARTED, p?.type ?? 'normal', {}, false));
    on('GENERATION_ENDED', async p => {
      await mirror.loadMessages();
      await bus.emit(tavern_events.GENERATION_ENDED, mirror.lastMessageId);
    });
    on('GENERATION_STOPPED', () => bus.emit(tavern_events.GENERATION_STOPPED));
    on('STREAM_TOKEN_RECEIVED', p => bus.emit(tavern_events.STREAM_TOKEN_RECEIVED, p?.token ?? ''));
    on('SETTINGS_UPDATED', p => bus.emit(tavern_events.SETTINGS_UPDATED, p));
    on('CHARACTER_EDITED', async p => {
      await mirror.loadCharacter();
      await bus.emit(tavern_events.CHARACTER_EDITED, p);
    });
    on('PERSONA_CHANGED', p => bus.emit(tavern_events.PERSONA_CHANGED, p?.persona?.name ?? ''));
    return () => offs.forEach(o => o());
  }

  return { shared, bindFor, bridgeLumiverseEvents, substitudeMacros };
}
