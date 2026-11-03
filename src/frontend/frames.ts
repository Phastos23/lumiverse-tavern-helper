// Builds the srcdoc for script iframes (Path A: same-origin iframes, as JS-Slash-Runner does).
// The iframe reads its API from `window.parent.__TH__`, which the host registers in hostglobals.ts.

const PREDEFINE = `
(function () {
  var TH = window.parent.__TH__;
  if (!TH) { console.error('[TavernHelper] host bridge missing'); return; }
  var name = window.name;
  var caller = TH.callers[name];
  if (!caller) { console.error('[TavernHelper] unknown frame ' + name); return; }
  var api = Object.assign({}, TH.shared, caller.api);
  Object.keys(api).forEach(function (k) { window[k] = api[k]; });
  window.TavernHelper = api;
  window._ = TH._;
  window.YAML = TH.YAML;
  window.z = TH.z;
  window.toastr = TH.shared.toastr;
  // Script iframes share the host page's jQuery, like JS-Slash-Runner. Message iframes get a document-scoped copy.
  if (caller.mode === 'script') {
    window.$ = window.jQuery = TH.$;
  } else {
    var jq = TH.$;
    var scoped = function (s, c) {
      if (typeof s === 'function') {
        if (document.readyState !== 'loading') return s(scoped);
        return document.addEventListener('DOMContentLoaded', function () { s(scoped); });
      }
      return jq(s, c || document);
    };
    Object.assign(scoped, jq);
    window.$ = window.jQuery = scoped;
  }
  Object.defineProperty(window, 'SillyTavern', { get: function () { return TH.stContext(caller); }, configurable: true });
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lvl) {
    var orig = console[lvl].bind(console);
    console[lvl] = function () {
      try { TH.log(caller.scriptId || name, lvl, Array.prototype.slice.call(arguments)); } catch (e) {}
      orig.apply(null, arguments);
    };
  });
  window.addEventListener('error', function (e) { try { TH.log(caller.scriptId || name, 'error', [e.message]); } catch (x) {} });
  window.addEventListener('unhandledrejection', function (e) { try { TH.log(caller.scriptId || name, 'error', [String(e.reason)]); } catch (x) {} });
  window.addEventListener('pagehide', function () { try { api.eventClearAll(); } catch (e) {} });
})();`;

/** Strip a surrounding markdown code fence if the user pasted one, like JS-Slash-Runner does. */
function unfence(content: string): string {
  const m = content.match(/^\s*```[^\n]*\n([\s\S]*)\n```\s*$/);
  return m ? m[1] : content;
}

function safeInline(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

export function buildScriptDoc(content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>${safeInline(PREDEFINE)}</script>
</head>
<body>
<script type="module">
${safeInline(unfence(content))}
</script>
</body>
</html>`;
}

/** For message code blocks: full HTML documents are kept as they are, with the predefine script injected first. */
export function buildMessageDoc(content: string): string {
  const inject = `<script>${safeInline(PREDEFINE)}</script>`;
  const base = `<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;max-width:100%}</style>`;
  const text = unfence(content);
  if (/<head[\s>]/i.test(text)) return text.replace(/<head([^>]*)>/i, `<head$1>${inject}${base}`);
  if (/<html[\s>]/i.test(text)) return text.replace(/<html([^>]*)>/i, `<html$1><head>${inject}${base}</head>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${inject}${base}</head><body>${text}</body></html>`;
}
