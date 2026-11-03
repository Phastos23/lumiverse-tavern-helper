import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { Rpc } from './rpc';

export type ScopeKey = 'chat' | 'global' | 'character' | 'preset';

export interface MirrorMessage {
  id: string;
  index: number;
  name: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  hidden: boolean;
  swipe_id: number;
  swipes: string[];
  extra: Record<string, any>;
}

/**
 * Lumiverse only exposes data asynchronously, but JS-Slash-Runner scripts call many getters synchronously
 * (getVariables, getChatMessages, getCurrentCharacterName...). The mirror keeps the current state in memory
 * so those getters stay synchronous; writes update the mirror immediately and flush to the backend in order.
 */
export class Mirror {
  chatId: string | null = null;
  characterId: string | null = null;
  characterName = '';
  userName = 'User';
  messages: MirrorMessage[] = [];
  vars: Record<ScopeKey, Record<string, any>> = { chat: {}, global: {}, character: {}, preset: {} };
  messageVars = new Map<string, Record<string, any>>();
  scriptVars = new Map<string, Record<string, any>>();
  extensionVars = new Map<string, Record<string, any>>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  ready: Promise<void>;

  constructor(
    private ctx: SpindleFrontendContext,
    private rpc: Rpc,
  ) {
    this.ready = this.reload();
  }

  onChange(h: () => void) {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }
  private emit() {
    for (const h of this.listeners) h();
  }

  /** Full reload: active chat, messages, character, variables. */
  async reload(): Promise<void> {
    const active = this.ctx.getActiveChat();
    const chatChanged = active.chatId !== this.chatId;
    this.chatId = active.chatId;
    this.characterId = active.characterId;
    if (chatChanged) this.messageVars.clear();
    await Promise.all([this.loadMessages(), this.loadCharacter(), this.loadVars()]);
    this.emit();
  }

  /** Debounced message refresh used by event handlers. */
  scheduleRefresh(delay = 150) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.loadMessages().then(() => this.emit());
    }, delay);
  }

  async loadMessages(): Promise<void> {
    const c = this.ctx as any;
    if (!this.chatId || !c.messages?.list) {
      this.messages = [];
      return;
    }
    try {
      const list = (await c.messages.list(this.chatId)) as any[];
      this.messages = list
        .slice()
        .sort((a, b) => a.index_in_chat - b.index_in_chat)
        .map((m, i) => ({
          id: m.id,
          index: typeof m.index_in_chat === 'number' ? m.index_in_chat : i,
          name: m.name ?? '',
          role: m.is_user ? 'user' : m.extra?.is_system ? 'system' : 'assistant',
          content: m.content ?? '',
          hidden: !!m.extra?.hidden,
          swipe_id: m.swipe_id ?? 0,
          swipes: Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content ?? ''],
          extra: m.extra ?? {},
        }));
      const u = this.messages.find(m => m.role === 'user');
      if (u?.name) this.userName = u.name;
    } catch (e) {
      console.warn('[tavern_helper] failed to load messages', e);
    }
  }

  async loadCharacter(): Promise<void> {
    const c = this.ctx as any;
    if (!this.characterId || !c.characters?.get) {
      this.characterName = '';
      return;
    }
    try {
      const ch = await c.characters.get(this.characterId);
      this.characterName = ch?.name ?? '';
    } catch {
      this.characterName = '';
    }
  }

  async loadVars(): Promise<void> {
    try {
      const s = await this.rpc.call('vars.snapshot', { chatId: this.chatId, characterId: this.characterId });
      this.vars = { chat: s.chat ?? {}, global: s.global ?? {}, character: s.character ?? {}, preset: s.preset ?? {} };
    } catch (e) {
      console.warn('[tavern_helper] failed to load variables', e);
    }
  }

  messageByIndex(i: number): MirrorMessage | undefined {
    return this.messages.find(m => m.index === i);
  }
  get lastMessageId(): number {
    return this.messages.length ? this.messages[this.messages.length - 1].index : -1;
  }

  /** Queue an ordered backend write; failures are logged, not thrown into script code. */
  enqueue<T>(job: () => Promise<T>): Promise<T | undefined> {
    const run = this.writeQueue.then(job, job);
    this.writeQueue = run.catch(() => undefined);
    return run.catch(e => {
      console.error('[tavern_helper] backend write failed', e);
      return undefined;
    });
  }
  flush(): Promise<unknown> {
    return this.writeQueue;
  }
}
