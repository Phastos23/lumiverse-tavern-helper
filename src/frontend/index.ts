import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { createApi } from './api';
import { EventBus, tavern_events } from './events';
import { installHostGlobals, removeHostGlobals } from './hostglobals';
import { Mirror } from './mirror';
import { mountPanel } from './panel';
import { startMessageRenderer } from './render';
import { Rpc } from './rpc';
import { ScriptManager } from './scripts';
import { createWorldbookApi } from './worldbook';

export function setup(ctx: SpindleFrontendContext) {
  const rpc = new Rpc(ctx);
  const mirror = new Mirror(ctx, rpc);
  const bus = new EventBus();
  const callers = new Map<string, any>();
  let manager: ScriptManager | null = null;

  const log = (level: 'info' | 'warn' | 'error', ...args: unknown[]) => {
    (console as any)[level]('[tavern_helper]', ...args);
    manager?.addLog('host', level, args);
  };

  const api = createApi({ ctx, rpc, mirror, bus, log });
  const worldbooks = createWorldbookApi(rpc, mirror);
  Object.assign(api.shared, worldbooks.fns, {
    // Deprecated JS-Slash-Runner "lorebook" names that scripts still use.
    getLorebooks: worldbooks.fns.getWorldbookNames,
    getCharLorebooks: worldbooks.fns.getCharWorldbookNames,
    createLorebook: (name: string) => worldbooks.fns.createWorldbook(name),
    deleteLorebook: worldbooks.fns.deleteWorldbook,
  });

  installHostGlobals({
    shared: api.shared as unknown as Record<string, unknown>,
    callers,
    mirror,
    bus,
    scripts: () => manager,
    substitute: api.substitudeMacros,
  });

  const unbridge = api.bridgeLumiverseEvents();
  const refreshBooks = () => worldbooks.refreshBooks().catch(e => log('warn', 'could not load worldbooks', e));
  const bookListener = bus.on(tavern_events.CHAT_CHANGED, refreshBooks, 'host');
  manager = new ScriptManager(ctx, { rpc, mirror, bus, api, callers });
  const prefs = { renderCodeBlocks: true };
  const renderer = startMessageRenderer(ctx, { mirror, bus, api, callers }, { enabled: () => prefs.renderCodeBlocks });
  const loadPrefs = async () => {
    try {
      const saved = await (ctx as any).settings?.get('prefs');
      if (saved && typeof saved.renderCodeBlocks === 'boolean') prefs.renderCodeBlocks = saved.renderCodeBlocks;
    } catch {
      /* keep defaults */
    }
  };
  const savePrefs = async () => {
    try {
      await (ctx as any).settings?.set('prefs', { ...prefs });
    } catch {
      /* ignore */
    }
    renderer.rescan();
  };
  const unmount = mountPanel(ctx, manager, rpc, { prefs, savePrefs });

  void (async () => {
    await loadPrefs();
    renderer.rescan();
    await manager!.load();
    await mirror.ready;
    await refreshBooks();
    await manager!.sync();
    await bus.emit(tavern_events.APP_READY);
    log('info', 'ready');
  })().catch(e => log('error', 'startup failed', e));

  return () => {
    unmount();
    renderer.stop();
    unbridge();
    bookListener.stop();
    manager?.dispose();
    rpc.dispose();
    removeHostGlobals();
  };
}
