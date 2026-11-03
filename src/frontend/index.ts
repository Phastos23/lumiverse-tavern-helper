import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { createApi } from './api';
import { EventBus, tavern_events } from './events';
import { installHostGlobals, removeHostGlobals } from './hostglobals';
import { Mirror } from './mirror';
import { mountPanel } from './panel';
import { Rpc } from './rpc';
import { ScriptManager } from './scripts';

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
  installHostGlobals({
    shared: api.shared as unknown as Record<string, unknown>,
    callers,
    mirror,
    bus,
    scripts: () => manager,
    substitute: api.substitudeMacros,
  });

  const unbridge = api.bridgeLumiverseEvents();
  manager = new ScriptManager(ctx, { rpc, mirror, bus, api, callers });
  const unmount = mountPanel(ctx, manager, rpc);

  void (async () => {
    await manager!.load();
    await mirror.ready;
    await manager!.sync();
    await bus.emit(tavern_events.APP_READY);
    log('info', 'ready');
  })().catch(e => log('error', 'startup failed', e));

  return () => {
    unmount();
    unbridge();
    manager?.dispose();
    rpc.dispose();
    removeHostGlobals();
  };
}
