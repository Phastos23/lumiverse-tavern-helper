import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Request/response channel to the backend, plus a hook for pushed backend messages. */
export class Rpc {
  private pending = new Map<string, Pending>();
  private seq = 0;
  private pushHandlers = new Set<(msg: any) => void>();
  private off: () => void;

  constructor(private ctx: SpindleFrontendContext) {
    this.off = ctx.onBackendMessage((p: any) => {
      if (p?.type === 'rpc_result') {
        const w = this.pending.get(p.id);
        if (!w) return;
        this.pending.delete(p.id);
        p.ok ? w.resolve(p.value) : w.reject(new Error(p.error));
      } else {
        for (const h of this.pushHandlers) h(p);
      }
    });
  }

  call<T = any>(method: string, args?: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.newId();
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Backend call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => (clearTimeout(t), resolve(v)),
        reject: e => (clearTimeout(t), reject(e)),
      });
      this.ctx.sendToBackend({ type: 'rpc', id, method, args });
    });
  }

  newId(): string {
    return `${Date.now().toString(36)}-${++this.seq}-${Math.random().toString(36).slice(2, 6)}`;
  }

  onPush(h: (msg: any) => void): () => void {
    this.pushHandlers.add(h);
    return () => this.pushHandlers.delete(h);
  }

  dispose() {
    this.off();
    this.pending.clear();
    this.pushHandlers.clear();
  }
}
