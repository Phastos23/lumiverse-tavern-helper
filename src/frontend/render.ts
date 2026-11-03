// Renders HTML code blocks in chat messages as live iframes, like JS-Slash-Runner's "render code block" feature.
//
// Lumiverse draws a fence as <div class="…codeBlock"><div header/><pre><code class="hljs">…</code></pre></div>.
// We watch for those, hide the wrapper and place an iframe after it. Messages are re-written wholesale while
// streaming, so blocks are only rendered once their text has been stable for a moment, and removed iframes are
// recreated by the next scan.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { createApi } from './api';
import { iframe_events, type EventBus } from './events';
import { buildMessageDoc } from './frames';
import type { Mirror } from './mirror';

/** A fence is worth rendering when it looks like a web page or widget rather than a snippet of prose. */
export function looksRenderable(code: string): boolean {
  return /<\s*(?:!doctype|html|head|body|script|style)\b/i.test(code) || /<\s*(?:div|section|table|canvas|svg|button|details)\b[^>]*\bstyle\s*=/i.test(code);
}

/** `min-height: 100vh` collapses inside an auto-height iframe, so tie vh to the host viewport like JSR does. */
export function replaceVh(content: string): string {
  const toVar = (v: string) =>
    v.replace(/(\d+(?:\.\d+)?)vh\b/gi, (_m, n) => {
      const x = parseFloat(n);
      return x === 100 ? 'var(--TH-viewport-height)' : `calc(var(--TH-viewport-height) * ${x / 100})`;
    });
  return content
    .replace(/(min-height\s*:\s*)([^;{}"']*?\d+(?:\.\d+)?vh)(?=\s*[;}"'])/gi, (_m, p, v) => p + toVar(v))
    .replace(/(\.style\.minHeight\s*=\s*(["']))([^"']*?vh)(\2)/gi, (m, p, _q, v, s) => (/\d+(?:\.\d+)?vh/i.test(v) ? p + toVar(v) + s : m));
}

interface BlockState {
  frame: HTMLIFrameElement;
  wrapper: HTMLElement;
  pre: HTMLElement;
  code: string;
  callerName: string;
  owner: string;
  ro?: ResizeObserver;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RenderOptions {
  enabled: () => boolean;
}

export function startMessageRenderer(
  ctx: SpindleFrontendContext,
  env: { mirror: Mirror; bus: EventBus; api: ReturnType<typeof createApi>; callers: Map<string, any> },
  options: RenderOptions,
) {
  const { mirror, bus, api, callers } = env;
  const states = new Map<HTMLElement, BlockState>();
  const pending = new Map<HTMLElement, { code: string; since: number }>();
  const STABLE_MS = 700;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let counter = 0;

  const wrapperOf = (pre: HTMLElement): HTMLElement => {
    const parent = pre.parentElement;
    return parent && /codeBlock/i.test(parent.className) ? parent : pre;
  };

  function destroy(pre: HTMLElement) {
    const st = states.get(pre);
    if (!st) return;
    clearTimeout(st.timer);
    st.ro?.disconnect();
    bus.clearOwner(st.owner);
    callers.delete(st.callerName);
    st.frame.remove();
    st.wrapper.style.removeProperty('display');
    states.delete(pre);
  }

  function mount(pre: HTMLElement, code: string, messageId: string) {
    const wrapper = wrapperOf(pre);
    const msg = mirror.messages.find(m => m.id === messageId);
    const messageIndex = msg?.index ?? -1;
    const n = ++counter;
    const callerName = `TH-message--${messageIndex}--${n}`;
    const owner = `msg:${messageId}:${n}`;
    callers.set(callerName, {
      mode: 'message',
      scriptId: callerName,
      api: api.bindFor({ owner, iframeName: callerName, messageId: messageIndex, scriptId: callerName, scriptName: callerName }),
    });

    const frame = document.createElement('iframe');
    frame.name = callerName;
    frame.id = callerName;
    frame.setAttribute('data-th-message-frame', messageId);
    frame.style.cssText = 'width:100%;border:0;display:block;overflow:hidden;background:transparent;min-height:24px';
    frame.srcdoc = buildMessageDoc(replaceVh(code));
    wrapper.style.display = 'none';
    wrapper.after(frame);

    const st: BlockState = { frame, wrapper, pre, code, callerName, owner };
    states.set(pre, st);
    void bus.emit(iframe_events.MESSAGE_IFRAME_RENDER_STARTED, callerName);

    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const setVh = () => doc.documentElement.style.setProperty('--TH-viewport-height', `${window.innerHeight}px`);
      setVh();
      window.addEventListener('resize', setVh);
      const fit = () => {
        const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
        if (h > 0) frame.style.height = `${h}px`;
      };
      fit();
      st.ro = new ResizeObserver(fit);
      st.ro.observe(doc.documentElement);
      if (doc.body) st.ro.observe(doc.body);
      void bus.emit(iframe_events.MESSAGE_IFRAME_RENDER_ENDED, callerName);
    });
  }

  function scan() {
    scanTimer = null;
    if (!options.enabled()) {
      for (const pre of [...states.keys()]) destroy(pre);
      return;
    }
    // Drop state for blocks that left the DOM.
    for (const pre of [...states.keys()]) if (!pre.isConnected) destroy(pre);
    for (const pre of [...pending.keys()]) if (!pre.isConnected) pending.delete(pre);

    const now = Date.now();
    let needAnotherScan = false;
    for (const pre of Array.from(document.querySelectorAll<HTMLElement>('[data-message-id] pre'))) {
      const messageId = ctx.dom.getMessageId(pre);
      if (!messageId) continue;
      const code = (pre.querySelector('code') ?? pre).textContent ?? '';
      const st = states.get(pre);

      if (st) {
        // Re-attach if the host re-rendered the message and dropped our iframe.
        if (!st.frame.isConnected) {
          destroy(pre);
        } else if (st.code !== code) {
          // The block changed (streaming): restart it once the text settles.
          clearTimeout(st.timer);
          st.timer = setTimeout(() => {
            destroy(pre);
            scheduleScan(0);
          }, STABLE_MS);
          continue;
        } else {
          continue;
        }
      }
      if (!looksRenderable(code)) continue;
      const p = pending.get(pre);
      if (!p || p.code !== code) {
        pending.set(pre, { code, since: now });
        needAnotherScan = true;
        continue;
      }
      if (now - p.since < STABLE_MS) {
        needAnotherScan = true;
        continue;
      }
      pending.delete(pre);
      mount(pre, code, messageId);
    }
    if (needAnotherScan) scheduleScan(STABLE_MS / 2);
  }

  function scheduleScan(delay = 150) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay);
  }

  const observer = new MutationObserver(records => {
    // Ignore changes caused by our own iframes.
    if (records.every(r => (r.target as HTMLElement).closest?.('[data-th-message-frame]'))) return;
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scheduleScan(300);

  return {
    rescan: () => scheduleScan(0),
    stop() {
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      for (const pre of [...states.keys()]) destroy(pre);
    },
  };
}
