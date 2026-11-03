import $ from 'jquery';
import _ from 'lodash';
import YAML from 'yaml';
import * as z from 'zod';
import type { Mirror } from './mirror';
import type { ScriptManager } from './scripts';
import { tavern_events } from './events';
import type { EventBus } from './events';

/**
 * The bridge that same-origin script iframes read through `window.parent.__TH__`.
 * It lives under one private name so nothing is added to the host page's own globals (no `_`, `$`, ...).
 */
export function installHostGlobals(deps: {
  shared: Record<string, unknown>;
  callers: Map<string, any>;
  mirror: Mirror;
  bus: EventBus;
  scripts: () => ScriptManager | null;
  substitute: (s: string) => string;
}) {
  const { shared, callers, mirror, bus, scripts, substitute } = deps;

  const stContext = (_caller: unknown) => {
    const chat = mirror.messages.map(m => ({
      name: m.name,
      is_user: m.role === 'user',
      is_system: m.role === 'system',
      mes: m.content,
      swipe_id: m.swipe_id,
      swipes: m.swipes,
      extra: m.extra,
    }));
    const ctxObj = {
      chat,
      name1: mirror.userName,
      name2: mirror.characterName,
      characterId: mirror.characterId,
      chatId: mirror.chatId,
      getCurrentChatId: () => mirror.chatId,
      event_types: { ...tavern_events },
      eventSource: {
        on: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, 'st-compat'),
        once: (e: string, fn: (...a: any[]) => any) => bus.on(e, fn, 'st-compat', { once: true }),
        off: (e: string, fn: (...a: any[]) => any) => bus.off(e, fn),
        removeListener: (e: string, fn: (...a: any[]) => any) => bus.off(e, fn),
        emit: (e: string, ...d: any[]) => bus.emit(e, ...d),
      },
      substituteParams: substitute,
      saveSettingsDebounced: () => undefined,
      saveChat: async () => undefined,
      writeExtensionField: async () => undefined,
    };
    return { ...ctxObj, getContext: () => ctxObj };
  };

  (window as any).__TH__ = {
    _,
    $,
    YAML,
    z,
    shared,
    callers: {
      get length() {
        return callers.size;
      },
    },
    stContext,
    log: (scriptId: string, level: string, args: unknown[]) => scripts()?.addLog(scriptId, level, args),
  };
  // `callers` must be indexable by iframe name, so expose the live Map through a Proxy.
  (window as any).__TH__.callers = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => callers.get(key),
    has: (_t, key: string) => callers.has(key),
  });
}

export function removeHostGlobals() {
  delete (window as any).__TH__;
}
