// Event bus compatible with the JS-Slash-Runner eventOn/eventEmit API, bridged from Lumiverse events.

export const iframe_events = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const;

export const tavern_events = {
  APP_READY: 'app_ready',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SETTINGS_UPDATED: 'settings_updated',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_DELETED: 'character_deleted',
  PERSONA_CHANGED: 'persona_changed',
} as const;

type Fn = (...args: any[]) => any;
interface Entry {
  fn: Fn;
  owner: string; // script/frame that registered it, so its listeners are dropped when it is destroyed
  once: boolean;
}

export class EventBus {
  private map = new Map<string, Entry[]>();

  on(event: string, fn: Fn, owner = 'host', opts: { once?: boolean; first?: boolean } = {}) {
    const list = this.map.get(event) ?? [];
    const entry: Entry = { fn, owner, once: !!opts.once };
    if (opts.first) list.unshift(entry);
    else list.push(entry);
    this.map.set(event, list);
    return { stop: () => this.off(event, fn) };
  }
  off(event: string, fn: Fn) {
    const list = this.map.get(event);
    if (!list) return;
    const i = list.findIndex(e => e.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }
  clearEvent(event: string) {
    this.map.delete(event);
  }
  clearListener(fn: Fn) {
    for (const list of this.map.values()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
    }
  }
  clearOwner(owner: string) {
    for (const list of this.map.values()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
    }
  }
  async emit(event: string, ...data: any[]) {
    for (const e of (this.map.get(event) ?? []).slice()) {
      if (e.once) this.off(event, e.fn);
      try {
        await e.fn(...data);
      } catch (err) {
        console.error(`[tavern_helper] listener for "${event}" threw`, err);
      }
    }
  }
  emitSync(event: string, ...data: any[]) {
    for (const e of (this.map.get(event) ?? []).slice()) {
      if (e.once) this.off(event, e.fn);
      try {
        e.fn(...data);
      } catch (err) {
        console.error(`[tavern_helper] listener for "${event}" threw`, err);
      }
    }
  }
}
