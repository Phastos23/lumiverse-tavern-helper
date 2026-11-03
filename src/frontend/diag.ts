import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { Rpc } from './rpc';

type Report = Record<string, unknown>;

const CDN_JQUERY = 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js';

function probeScript(reportExpr: string): string {
  return `
(function(){
  var r = {};
  try { r.parentDocumentReadable = !!(window.parent && window.parent.document && window.parent.document.title !== undefined); } catch(e){ r.parentDocumentReadable = false; }
  try { r.parentGlobalReadable = typeof window.parent.__th_spike !== 'undefined'; } catch(e){ r.parentGlobalReadable = false; }
  try { new Function('return 1')(); r.evalAllowed = true; } catch(e){ r.evalAllowed = false; }
  try { fetch('https://cdn.jsdelivr.net/npm/jquery@3.7.1/package.json').then(function(){ r.fetch = 'ok'; }).catch(function(e){ r.fetch = 'blocked: ' + e; }); } catch(e){ r.fetch = 'throws'; }
  var s = document.createElement('script');
  s.src = '${CDN_JQUERY}';
  s.onload = function(){ r.cdnScript = 'loaded'; done(); };
  s.onerror = function(){ r.cdnScript = 'blocked'; done(); };
  document.head.appendChild(s);
  var sent = false;
  function done(){ if (sent) return; sent = true; setTimeout(function(){ ${reportExpr}(r); }, 300); }
  setTimeout(done, 4000);
})();`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | string> {
  return Promise.race([p, new Promise<string>(res => setTimeout(() => res(`${label}: timed out`), ms))]);
}

async function testPathA(): Promise<Report | string> {
  (window as any).__th_spike = { hello: 'from host' };
  return withTimeout(
    new Promise<Report>(resolve => {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.srcdoc = `<!DOCTYPE html><html><head></head><body><script>${probeScript('window.parent.__th_spike_cb')}<\/script></body></html>`;
      (window as any).__th_spike_cb = (r: Report) => {
        frame.remove();
        resolve(r);
      };
      document.body.appendChild(frame);
    }).catch(e => `Path A failed: ${String(e)}`),
    8000,
    'Path A',
  );
}

async function testPathB(ctx: SpindleFrontendContext): Promise<Report | string> {
  try {
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.appendChild(host);
    return await withTimeout(
      new Promise<Report>(resolve => {
        const frame = ctx.dom.createSandboxFrame({
          html: `<!DOCTYPE html><html><body><script>${probeScript('window.spindleSandbox.postMessage')}<\/script></body></html>`,
          initialHeight: 10,
        });
        frame.onMessage(msg => {
          frame.destroy();
          host.remove();
          resolve(msg as Report);
        });
        host.appendChild(frame.element);
      }),
      8000,
      'Path B',
    );
  } catch (e) {
    return `Path B failed: ${String(e)}`;
  }
}

function apiSurface(ctx: SpindleFrontendContext): Report {
  const c = ctx as any;
  return {
    lumiverseVersion: c.host?.lumiverseVersion,
    capabilities: c.host?.capabilities,
    activeChat: (() => {
      try {
        return ctx.getActiveChat();
      } catch (e) {
        return String(e);
      }
    })(),
    hasState: !!c.state,
    messagesList: typeof c.messages?.list,
    chatsGetMessages: typeof c.chats?.getMessages,
    messagesGetRecent: typeof c.messages?.getRecent,
    charactersGet: typeof c.characters?.get,
    worldBooks: !!c.worldBooks,
    settings: !!c.settings,
    tagInterceptor: typeof c.messages?.registerTagInterceptor,
    renderWidget: typeof c.messages?.renderWidget,
    domDecorator: typeof c.registerDomDecorator,
    messageAction: typeof c.registerMessageAction,
  };
}

export async function runDiagnostics(ctx: SpindleFrontendContext, rpc: Rpc): Promise<Report> {
  const result: Report = {};
  result.api = apiSurface(ctx);
  const t0 = Date.now();
  result.backend = await withTimeout(
    rpc.call('ping', {}, 4000).then(() => ({ roundTripMs: Date.now() - t0 })),
    4500,
    'Backend',
  ).catch(e => `Backend error: ${String(e)}`);
  result.pathA_sameOriginIframe = await testPathA();
  result.pathB_sandboxFrame = await testPathB(ctx);
  delete (window as any).__th_spike;
  delete (window as any).__th_spike_cb;
  return result;
}
