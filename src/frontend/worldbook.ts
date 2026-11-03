// JS-Slash-Runner worldbook API on top of Lumiverse world books (backend RPC "wb.*").
// JSR addresses books by name and entries by numeric uid; Lumiverse uses ids. Conversions are pure and unit-tested.

import _ from 'lodash';
import type { Mirror } from './mirror';
import type { Rpc } from './rpc';

export type JsrEntry = {
  uid: number;
  name: string;
  enabled: boolean;
  strategy: {
    type: 'constant' | 'selective' | 'vectorized';
    keys: (string | RegExp)[];
    keys_secondary: { logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'; keys: (string | RegExp)[] };
    scan_depth: 'same_as_global' | number;
  };
  position: {
    type:
      | 'before_character_definition'
      | 'after_character_definition'
      | 'before_example_messages'
      | 'after_example_messages'
      | 'before_author_note'
      | 'after_author_note'
      | 'at_depth'
      | 'outlet';
    role: 'system' | 'assistant' | 'user';
    depth: number;
    order: number;
  };
  content: string;
  probability: number;
  recursion: { prevent_incoming: boolean; prevent_outgoing: boolean; delay_until: null | number };
  effect: { sticky: null | number; cooldown: null | number; delay: null | number };
  extra?: Record<string, any>;
};

const POSITION_TO_CODE = {
  before_character_definition: 0,
  after_character_definition: 1,
  before_author_note: 2,
  after_author_note: 3,
  at_depth: 4,
  before_example_messages: 5,
  after_example_messages: 6,
  outlet: 7,
} as const;
const CODE_TO_POSITION = _.invert(POSITION_TO_CODE) as Record<string, keyof typeof POSITION_TO_CODE>;

// JSR (SillyTavern) numbering -> Lumiverse numbering for secondary-key logic.
const LOGIC_TO_LUMI = { and_any: 2, not_all: 3, not_any: 1, and_all: 0 } as const;
const LUMI_TO_LOGIC: Record<number, keyof typeof LOGIC_TO_LUMI> = { 2: 'and_any', 3: 'not_all', 1: 'not_any', 0: 'and_all' };

const keyToString = (k: string | RegExp) => (k instanceof RegExp ? k.toString() : String(k));
/** "/pattern/flags" strings are how JSR/SillyTavern encode regex keys. */
const looksLikeRegexKey = (k: string) => /^\/.+\/[a-z]*$/.test(k);

/** Lumiverse entry -> JSR entry. `uidFor` supplies a stable numeric uid when the Lumiverse uid isn't numeric. */
export function toJsrEntry(e: any, uidFor: (e: any) => number): JsrEntry {
  const keysSecondary: string[] = e.keysecondary ?? [];
  const asKey = (k: string) => {
    if (e.use_regex && looksLikeRegexKey(k)) {
      const m = k.match(/^\/(.+)\/([a-z]*)$/)!;
      try {
        return new RegExp(m[1], m[2]);
      } catch {
        return k;
      }
    }
    return k;
  };
  return {
    uid: uidFor(e),
    name: e.comment ?? '',
    enabled: !e.disabled,
    strategy: {
      type: e.vectorized ? 'vectorized' : e.constant ? 'constant' : 'selective',
      keys: (e.key ?? []).map(asKey),
      keys_secondary: { logic: LUMI_TO_LOGIC[e.selective_logic ?? 0] ?? 'and_any', keys: keysSecondary.map(asKey) },
      scan_depth: typeof e.scan_depth === 'number' && e.scan_depth > 0 ? e.scan_depth : 'same_as_global',
    },
    position: {
      type: CODE_TO_POSITION[String(e.position ?? 4)] ?? 'at_depth',
      role: e.role === 'user' || e.role === 'assistant' ? e.role : 'system',
      depth: e.depth ?? 4,
      order: e.order_value ?? 100,
    },
    content: e.content ?? '',
    probability: e.use_probability === false ? 100 : (e.probability ?? 100),
    recursion: {
      prevent_incoming: !!e.exclude_recursion,
      prevent_outgoing: !!e.prevent_recursion,
      delay_until: e.delay_until_recursion ? 1 : null,
    },
    effect: {
      sticky: e.sticky > 0 ? e.sticky : null,
      cooldown: e.cooldown > 0 ? e.cooldown : null,
      delay: e.delay > 0 ? e.delay : null,
    },
    ...(e.extensions && Object.keys(e.extensions).length ? { extra: e.extensions } : {}),
  };
}

/** JSR (possibly partial) entry -> Lumiverse create/update payload. Only provided fields are emitted when `partial`. */
export function toLumiverseEntry(entry: any, opts: { partial: boolean }): Record<string, any> {
  const out: Record<string, any> = {};
  const has = (path: string) => _.has(entry, path);
  const full = !opts.partial;
  if (has('uid')) out.uid = String(entry.uid);
  if (has('name') || full) out.comment = entry.name ?? '';
  if (has('enabled') || full) out.disabled = !(entry.enabled ?? true);
  if (has('strategy.type') || full) {
    const t = entry.strategy?.type ?? 'constant';
    out.constant = t === 'constant';
    out.vectorized = t === 'vectorized';
    out.selective = t === 'selective';
  }
  const keys: Array<string | RegExp> | undefined = entry.strategy?.keys;
  const sec: Array<string | RegExp> | undefined = entry.strategy?.keys_secondary?.keys;
  if (keys || full) out.key = (keys ?? []).map(keyToString);
  if (sec || full) out.keysecondary = (sec ?? []).map(keyToString);
  if (keys || sec) {
    const anyRegex = [...(keys ?? []), ...(sec ?? [])].some(k => k instanceof RegExp || looksLikeRegexKey(String(k)));
    if (anyRegex) out.use_regex = true;
  }
  if (has('strategy.keys_secondary.logic') || full) out.selective_logic = LOGIC_TO_LUMI[(entry.strategy?.keys_secondary?.logic ?? 'and_any') as keyof typeof LOGIC_TO_LUMI] ?? 2;
  if (has('strategy.scan_depth') || full) {
    const d = entry.strategy?.scan_depth;
    out.scan_depth = typeof d === 'number' ? d : null;
  }
  if (has('position.type') || full) out.position = POSITION_TO_CODE[entry.position?.type as keyof typeof POSITION_TO_CODE] ?? 4;
  if (has('position.role') || full) out.role = entry.position?.role ?? 'system';
  if (has('position.depth') || full) out.depth = entry.position?.depth ?? 4;
  if (has('position.order') || full) out.order_value = entry.position?.order ?? 100;
  if (has('content') || full) out.content = entry.content ?? '';
  if (has('probability') || full) {
    out.probability = entry.probability ?? 100;
    out.use_probability = true;
  }
  if (has('recursion.prevent_incoming') || full) out.exclude_recursion = !!entry.recursion?.prevent_incoming;
  if (has('recursion.prevent_outgoing') || full) out.prevent_recursion = !!entry.recursion?.prevent_outgoing;
  if (has('recursion.delay_until') || full) out.delay_until_recursion = !!entry.recursion?.delay_until;
  if (has('effect.sticky') || full) out.sticky = entry.effect?.sticky ?? 0;
  if (has('effect.cooldown') || full) out.cooldown = entry.effect?.cooldown ?? 0;
  if (has('effect.delay') || full) out.delay = entry.effect?.delay ?? 0;
  if (has('extra')) out.extensions = entry.extra;
  return out;
}

export function createWorldbookApi(rpc: Rpc, mirror: Mirror) {
  const books = () => mirror.worldbooks;
  const idOf = (name: string): string => {
    const id = books().get(name);
    if (!id) throw new Error(`Worldbook "${name}" does not exist`);
    return id;
  };

  async function refreshBooks() {
    const list: Array<{ id: string; name: string }> = await rpc.call('wb.listBooks');
    mirror.worldbooks = new Map(list.map(b => [b.name, b.id]));
    mirror.globalWorldbookIds = await rpc.call('wb.getGlobal').catch(() => mirror.globalWorldbookIds);
    if (mirror.characterId) {
      mirror.characterWorldbookIds = await rpc.call('wb.getCharacterBooks', { characterId: mirror.characterId }).catch(() => []);
    }
  }

  // uid bookkeeping: JSR needs numeric uids that are stable across calls.
  const uidMap = new Map<string, number>();
  const uidFor = (e: any): number => {
    const n = Number(e.uid);
    if (Number.isFinite(n) && String(n) === String(e.uid)) return n;
    if (!uidMap.has(e.id)) uidMap.set(e.id, 1_000_000 + uidMap.size);
    return uidMap.get(e.id)!;
  };

  async function rawEntries(name: string): Promise<any[]> {
    return rpc.call('wb.listEntries', { bookId: idOf(name) });
  }
  async function getWorldbook(name: string): Promise<JsrEntry[]> {
    return (await rawEntries(name)).map(e => toJsrEntry(e, uidFor)).sort((a, b) => a.uid - b.uid);
  }

  /** Make `entries` the full contents of the book, diffing by uid so existing Lumiverse entries are updated in place. */
  async function replaceWorldbook(name: string, entries: any[]): Promise<void> {
    const bookId = idOf(name);
    const existing = await rawEntries(name);
    const byUid = new Map(existing.map(e => [uidFor(e), e]));
    const used = new Set<number>();
    let next = Math.max(0, ...existing.map(uidFor), ...entries.map(e => (typeof e.uid === 'number' ? e.uid : 0))) + 1;
    for (const entry of entries) {
      let uid: number = typeof entry.uid === 'number' && !used.has(entry.uid) ? entry.uid : next++;
      used.add(uid);
      const match = byUid.get(uid);
      if (match) {
        await rpc.call('wb.updateEntry', { entryId: match.id, data: toLumiverseEntry({ ...entry, uid }, { partial: true }) });
      } else {
        await rpc.call('wb.createEntry', { bookId, data: toLumiverseEntry({ ...entry, uid }, { partial: false }) });
      }
    }
    for (const [uid, e] of byUid) if (!used.has(uid)) await rpc.call('wb.deleteEntry', { entryId: e.id });
  }

  async function createWorldbook(name: string, entries: any[] = []): Promise<boolean> {
    if (books().has(name)) return false;
    const b = await rpc.call('wb.createBook', { name });
    books().set(b.name, b.id);
    if (entries.length) await replaceWorldbook(name, entries);
    return true;
  }

  const fns = {
    getWorldbookNames: () => [...books().keys()],
    getGlobalWorldbookNames: () => {
      const byId = new Map([...books()].map(([n, id]) => [id, n]));
      return mirror.globalWorldbookIds.map(id => byId.get(id)).filter((n): n is string => !!n);
    },
    rebindGlobalWorldbooks: async (names: string[]) => {
      const ids = names.map(idOf);
      mirror.globalWorldbookIds = await rpc.call('wb.setGlobal', { ids });
    },
    getCharWorldbookNames: (character: string) => {
      if (character !== 'current') throw new Error('getCharWorldbookNames: only "current" is supported on Lumiverse');
      const byId = new Map([...books()].map(([n, id]) => [id, n]));
      const names = mirror.characterWorldbookIds.map(id => byId.get(id)).filter((n): n is string => !!n);
      return { primary: names[0] ?? null, additional: names.slice(1) };
    },
    rebindCharWorldbooks: async (character: string, cw: { primary: string | null; additional: string[] }) => {
      if (character !== 'current') throw new Error('rebindCharWorldbooks: only "current" is supported on Lumiverse');
      if (!mirror.characterId) throw new Error('No active character');
      const ids = [cw.primary, ...cw.additional].filter((n): n is string => !!n).map(idOf);
      await rpc.call('wb.setCharacterBooks', { characterId: mirror.characterId, ids });
      mirror.characterWorldbookIds = ids;
    },
    getWorldbook,
    createWorldbook,
    createOrReplaceWorldbook: async (name: string, entries: any[] = []) => {
      if (books().has(name)) {
        await replaceWorldbook(name, entries);
        return false;
      }
      return createWorldbook(name, entries);
    },
    deleteWorldbook: async (name: string) => {
      if (!books().has(name)) return false;
      const ok = await rpc.call('wb.deleteBook', { bookId: idOf(name) });
      books().delete(name);
      return !!ok;
    },
    replaceWorldbook,
    updateWorldbookWith: async (name: string, updater: (w: JsrEntry[]) => any) => {
      const next = await updater(await getWorldbook(name));
      await replaceWorldbook(name, next);
      return getWorldbook(name);
    },
    createWorldbookEntries: async (name: string, newEntries: any[]) => {
      const before = await getWorldbook(name);
      const bookId = idOf(name);
      let next = Math.max(0, ...before.map(e => e.uid)) + 1;
      for (const entry of newEntries) {
        await rpc.call('wb.createEntry', { bookId, data: toLumiverseEntry({ ...entry, uid: next++ }, { partial: false }) });
      }
      const after = await getWorldbook(name);
      const beforeUids = new Set(before.map(e => e.uid));
      return { worldbook: after, new_entries: after.filter(e => !beforeUids.has(e.uid)) };
    },
    deleteWorldbookEntries: async (name: string, predicate: (e: JsrEntry) => boolean) => {
      const raw = await rawEntries(name);
      const deleted: JsrEntry[] = [];
      for (const r of raw) {
        const j = toJsrEntry(r, uidFor);
        if (predicate(j)) {
          await rpc.call('wb.deleteEntry', { entryId: r.id });
          deleted.push(j);
        }
      }
      return { worldbook: await getWorldbook(name), deleted_entries: deleted };
    },
  };

  return { fns, refreshBooks };
}
