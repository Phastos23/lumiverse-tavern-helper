import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { runDiagnostics } from './diag';
import type { Rpc } from './rpc';
import { newScript, normalizeTree, type Script, type ScriptFolder, type ScriptManager, type ScriptTree } from './scripts';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) (el as any)[k.toLowerCase()] = v;
    else if (v !== undefined && v !== false) (el as any)[k] = v;
  }
  for (const c of children) if (c) el.append(c as any);
  return el;
}

const BTN = 'padding:4px 10px;border-radius:6px;border:1px solid var(--lumiverse-border,#555);background:var(--lumiverse-fill-subtle,transparent);color:var(--lumiverse-text,inherit);cursor:pointer;font-size:12px';
const BOX = 'border:1px solid var(--lumiverse-border,#555);border-radius:8px;padding:8px;margin:6px 0';

function download(name: string, text: string) {
  // Plain <a download> is blocked in artifacts but works in a normal host page; fall back to showing the text.
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function pickTextFile(): Promise<string | null> {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null);
    input.click();
  });
}

export function mountPanel(ctx: SpindleFrontendContext, mgr: ScriptManager, rpc: Rpc) {
  const tab = ctx.ui.registerDrawerTab({
    id: 'tavern_helper',
    title: 'Tavern Helper',
    shortName: 'TH',
    description: 'Run JavaScript scripts with the Tavern-Helper API',
    keywords: ['script', 'javascript', 'tavern', 'helper'],
  });
  const root = tab.root;
  root.style.cssText = 'padding:10px;overflow:auto;font-size:13px';

  const buttonsBox = h('div');
  const listBox = h('div');
  const logBox = h('pre', { style: 'white-space:pre-wrap;word-break:break-word;font-size:11px;max-height:220px;overflow:auto;user-select:text;margin:0' });
  const diagBox = h('pre', { style: 'white-space:pre-wrap;word-break:break-word;font-size:11px;user-select:text;margin:6px 0 0' });

  async function persist(restart = true) {
    await mgr.save();
    if (restart) await mgr.sync();
    render();
  }

  function openEditor(script: Script) {
    const modal = ctx.ui.showModal({ title: `Edit script: ${script.name}` });
    const name = h('input', { value: script.name, style: 'width:100%;margin-bottom:6px' });
    const info = h('input', { value: script.info, placeholder: 'description', style: 'width:100%;margin-bottom:6px' });
    const buttons = h('input', {
      value: script.button.buttons.map(b => b.name).join(', '),
      placeholder: 'button names, comma separated',
      style: 'width:100%;margin-bottom:6px',
    });
    const code = h('textarea', {
      value: script.content,
      spellcheck: false,
      style: 'width:100%;min-height:50vh;font-family:ui-monospace,monospace;font-size:12px;tab-size:2',
    });
    const save = h('button', { style: BTN, textContent: 'Save' });
    save.onclick = async () => {
      script.name = name.value.trim() || 'Untitled';
      script.info = info.value;
      script.content = code.value;
      script.button.buttons = buttons.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(n => script.button.buttons.find(b => b.name === n) ?? { name: n, visible: true });
      mgr.stop(script.id); // restart with the new code if it is enabled
      modal.dismiss?.();
      await persist();
    };
    modal.root.append(name, info, buttons, code, h('div', { style: 'margin-top:6px' }, save));
  }

  function scriptRow(script: Script, folder?: ScriptFolder) {
    const active = mgr.isActive(script, folder);
    const toggle = h('input', { type: 'checkbox', checked: script.enabled, title: 'Enable' });
    toggle.onchange = async () => {
      script.enabled = toggle.checked;
      await persist();
    };
    const btn = (label: string, fn: () => void | Promise<void>) => h('button', { style: BTN + ';margin-left:4px', textContent: label, onclick: fn });
    return h(
      'div',
      { style: BOX + (folder ? ';margin-left:16px' : '') + (active ? ';border-color:var(--lumiverse-accent,#6a6)' : '') },
      h(
        'div',
        { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
        toggle,
        h('strong', { textContent: script.name, style: 'flex:1;min-width:6em' }),
        btn('Edit', () => openEditor(script)),
        btn('Export', () => download(`${script.name}.json`, JSON.stringify(script, null, 2))),
        btn('Delete', async () => {
          const { confirmed } = await ctx.ui.showConfirm({ title: 'Delete script', message: `Delete "${script.name}"?`, variant: 'danger', confirmLabel: 'Delete' });
          if (!confirmed) return;
          mgr.stop(script.id);
          if (folder) folder.scripts = folder.scripts.filter(s => s !== script);
          else mgr.trees = mgr.trees.filter(t => t !== script);
          await persist();
        }),
      ),
      script.info ? h('div', { textContent: script.info, style: 'opacity:.7;font-size:12px;margin-top:4px' }) : null,
    );
  }

  function folderRow(folder: ScriptFolder) {
    const toggle = h('input', { type: 'checkbox', checked: folder.enabled, title: 'Enable folder' });
    toggle.onchange = async () => {
      folder.enabled = toggle.checked;
      await persist();
    };
    return h(
      'div',
      { style: 'margin:6px 0' },
      h('div', { style: 'display:flex;gap:6px;align-items:center' }, toggle, h('strong', { textContent: `\u{1F4C1} ${folder.name}` })),
      ...folder.scripts.map(s => scriptRow(s, folder)),
    );
  }

  function render() {
    buttonsBox.replaceChildren(
      ...mgr.buttons().map(({ script, button }) =>
        h('button', { style: BTN + ';margin:2px', textContent: button.name, title: script.name, onclick: () => mgr.clickButton(script, button) }),
      ),
    );
    listBox.replaceChildren(
      ...(mgr.trees.length
        ? mgr.trees.map(t => (t.type === 'folder' ? folderRow(t) : scriptRow(t)))
        : [h('div', { textContent: 'No scripts yet. Add one or import a JS-Slash-Runner export.', style: 'opacity:.7' })]),
    );
    const names = new Map(mgr.allScripts().map(({ script }) => [script.id, script.name]));
    logBox.textContent = mgr.logs
      .slice(-120)
      .map(l => `${new Date(l.time).toLocaleTimeString()} [${l.level}] ${names.get(l.scriptId) ?? l.scriptId}: ${l.text}`)
      .join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }

  const addBtn = h('button', {
    style: BTN,
    textContent: '+ New script',
    onclick: async () => {
      mgr.trees.push(newScript());
      await persist(false);
    },
  });
  const importBtn = h('button', {
    style: BTN + ';margin-left:6px',
    textContent: 'Import',
    onclick: async () => {
      const text = await pickTextFile();
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        const items = (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeTree).filter((t): t is ScriptTree => !!t);
        for (const it of items) {
          it.enabled = false; // never auto-run imported code; the user enables it after reviewing
          if (it.type === 'folder') it.scripts.forEach(s => (s.enabled = false));
        }
        mgr.trees.push(...items);
        await persist(false);
      } catch (e) {
        void ctx.ui.showConfirm({ title: 'Import failed', message: String(e), variant: 'danger', confirmLabel: 'OK' });
      }
    },
  });
  const exportAll = h('button', {
    style: BTN + ';margin-left:6px',
    textContent: 'Export all',
    onclick: () => download('tavern-helper-scripts.json', JSON.stringify(mgr.trees, null, 2)),
  });
  const diagBtn = h('button', {
    style: BTN,
    textContent: 'Run compatibility tests',
    onclick: async () => {
      diagBtn.disabled = true;
      diagBox.textContent = 'Running...';
      try {
        diagBox.textContent = JSON.stringify(await runDiagnostics(ctx, rpc), null, 2);
      } catch (e) {
        diagBox.textContent = String(e);
      }
      diagBtn.disabled = false;
    },
  });
  const clearLogs = h('button', {
    style: BTN + ';margin-left:6px',
    textContent: 'Clear',
    onclick: () => ((mgr.logs.length = 0), render()),
  });

  root.append(
    h('h3', { textContent: 'Tavern Helper', style: 'margin:0 0 6px' }),
    h('div', {
      textContent:
        'Scripts run as JavaScript with access to your chats, characters and variables. Only enable scripts you trust.',
      style: 'opacity:.75;font-size:12px;margin-bottom:8px',
    }),
    buttonsBox,
    h('div', { style: 'margin:8px 0' }, addBtn, importBtn, exportAll),
    listBox,
    h('h4', { textContent: 'Console', style: 'margin:12px 0 4px' }),
    h('div', { style: BOX }, logBox),
    h('div', {}, clearLogs),
    h('h4', { textContent: 'Diagnostics', style: 'margin:12px 0 4px' }),
    diagBtn,
    diagBox,
  );

  const off = mgr.onChange(render);
  render();
  return () => {
    off();
    tab.destroy();
  };
}
