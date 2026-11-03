import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { createApi, type Caller } from './api';
import { EventBus } from './events';
import { buildScriptDoc } from './frames';
import type { Mirror } from './mirror';
import type { Rpc } from './rpc';

export interface ScriptButton {
  name: string;
  visible: boolean;
}
export interface Script {
  type: 'script';
  enabled: boolean;
  name: string;
  id: string;
  content: string;
  info: string;
  button: { enabled: boolean; buttons: ScriptButton[] };
  data: Record<string, any>;
  export_with: { data: boolean; button: boolean };
}
export interface ScriptFolder {
  type: 'folder';
  enabled: boolean;
  name: string;
  id: string;
  icon: string;
  color: string;
  scripts: Script[];
}
export type ScriptTree = Script | ScriptFolder;

export const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      });

/** Accepts JS-Slash-Runner's exported JSON and fills any missing fields. */
export function normalizeTree(raw: any): ScriptTree | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'folder' || Array.isArray(raw.scripts)) {
    return {
      type: 'folder',
      enabled: !!raw.enabled,
      name: String(raw.name ?? ''),
      id: String(raw.id ?? uuid()),
      icon: String(raw.icon ?? 'fa-solid fa-folder'),
      color: String(raw.color ?? ''),
      scripts: (raw.scripts ?? []).map(normalizeTree).filter((s: ScriptTree | null): s is Script => !!s && s.type === 'script'),
    };
  }
  return {
    type: 'script',
    enabled: !!raw.enabled,
    name: String(raw.name ?? ''),
    id: String(raw.id ?? uuid()),
    content: String(raw.content ?? ''),
    info: String(raw.info ?? ''),
    button: {
      enabled: raw.button?.enabled ?? true,
      buttons: (raw.button?.buttons ?? []).map((b: any) => ({ name: String(b.name ?? ''), visible: !!b.visible })),
    },
    data: raw.data && typeof raw.data === 'object' ? raw.data : {},
    export_with: { data: raw.export_with?.data ?? true, button: raw.export_with?.button ?? true },
  };
}

export function newScript(): Script {
  return normalizeTree({ type: 'script', name: 'New script', enabled: false, content: "// your script\nconsole.log('hello from', getScriptName());\n" }) as Script;
}

export interface LogEntry {
  time: number;
  scriptId: string;
  level: string;
  text: string;
}

const SETTINGS_KEY = 'script_trees';

export class ScriptManager {
  trees: ScriptTree[] = [];
  logs: LogEntry[] = [];
  private frames = new Map<string, HTMLIFrameElement>();
  private listeners = new Set<() => void>();
  private host!: HTMLElement;

  constructor(
    private ctx: SpindleFrontendContext,
    private env: { rpc: Rpc; mirror: Mirror; bus: EventBus; api: ReturnType<typeof createApi>; callers: Map<string, any> },
  ) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-tavern-helper-scripts', '');
    this.host.style.cssText = 'display:none';
    document.body.appendChild(this.host);
  }

  onChange(h: () => void) {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }
  private emit() {
    for (const h of this.listeners) h();
  }

  addLog(scriptId: string, level: string, args: unknown[]) {
    const text = args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    this.logs.push({ time: Date.now(), scriptId, level, text });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.emit();
  }

  allScripts(): Array<{ script: Script; folder?: ScriptFolder }> {
    const out: Array<{ script: Script; folder?: ScriptFolder }> = [];
    for (const t of this.trees) {
      if (t.type === 'script') out.push({ script: t });
      else for (const s of t.scripts) out.push({ script: s, folder: t });
    }
    return out;
  }

  isActive(script: Script, folder?: ScriptFolder) {
    return script.enabled && (!folder || folder.enabled);
  }

  async load() {
    let raw: any;
    try {
      raw = await (this.ctx as any).settings?.get(SETTINGS_KEY);
    } catch {
      /* fall through */
    }
    if (raw === undefined) {
      try {
        raw = JSON.parse(localStorage.getItem('tavern_helper_' + SETTINGS_KEY) ?? 'null');
      } catch {
        raw = undefined;
      }
    }
    this.trees = (Array.isArray(raw) ? raw : []).map(normalizeTree).filter((t: ScriptTree | null): t is ScriptTree => !!t);
    this.emit();
  }

  async save() {
    try {
      if ((this.ctx as any).settings) await (this.ctx as any).settings.set(SETTINGS_KEY, this.trees);
      else localStorage.setItem('tavern_helper_' + SETTINGS_KEY, JSON.stringify(this.trees));
    } catch (e) {
      console.error('[tavern_helper] failed to save scripts', e);
    }
    this.emit();
  }

  /** Start enabled scripts, stop disabled ones. */
  async sync() {
    const wanted = new Map<string, Script>();
    for (const { script, folder } of this.allScripts()) if (this.isActive(script, folder)) wanted.set(script.id, script);
    for (const id of [...this.frames.keys()]) if (!wanted.has(id)) this.stop(id);
    for (const [id, script] of wanted) if (!this.frames.has(id)) await this.start(script);
    this.emit();
  }

  async start(script: Script) {
    await this.env.mirror.ready;
    const name = `TH-script--${script.name}--${script.id}`;
    const caller: Caller = { owner: `script:${script.id}`, scriptId: script.id, scriptName: script.name, iframeName: name };
    this.env.callers.set(name, { mode: 'script', scriptId: script.id, api: this.env.api.bindFor(caller) });
    // Preload the script's own variables so synchronous reads in the first tick already see them.
    try {
      const v = await this.env.rpc.call('vars.read', { type: 'script', script_id: script.id });
      this.env.mirror.scriptVars.set(script.id, v ?? {});
    } catch {
      /* ignore */
    }
    const frame = document.createElement('iframe');
    frame.name = name;
    frame.id = name;
    frame.style.cssText = 'display:none;width:0;height:0;border:0';
    frame.srcdoc = buildScriptDoc(script.content);
    this.host.appendChild(frame);
    this.frames.set(script.id, frame);
    this.addLog(script.id, 'info', [`started "${script.name}"`]);
  }

  stop(scriptId: string) {
    const frame = this.frames.get(scriptId);
    if (!frame) return;
    try {
      (frame.contentWindow as any)?.eval?.('window.dispatchEvent(new Event("pagehide"))');
    } catch {
      /* ignore */
    }
    this.env.bus.clearOwner(`script:${scriptId}`);
    this.env.callers.delete(frame.name);
    frame.remove();
    this.frames.delete(scriptId);
    this.addLog(scriptId, 'info', ['stopped']);
  }

  /** Buttons of active scripts, for the panel. */
  buttons(): Array<{ script: Script; button: ScriptButton }> {
    const out: Array<{ script: Script; button: ScriptButton }> = [];
    for (const { script, folder } of this.allScripts()) {
      if (!this.isActive(script, folder) || !script.button.enabled) continue;
      for (const b of script.button.buttons) if (b.visible) out.push({ script, button: b });
    }
    return out;
  }

  clickButton(script: Script, button: ScriptButton) {
    void this.env.bus.emit(`${script.id}_${button.name}`);
  }

  dispose() {
    for (const id of [...this.frames.keys()]) this.stop(id);
    this.host.remove();
    this.listeners.clear();
  }
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? '\n' + v.stack : ''}`;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
