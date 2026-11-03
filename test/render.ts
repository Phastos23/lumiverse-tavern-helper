import { looksRenderable, replaceVh } from '../src/frontend/render';
import { buildMessageDoc, buildScriptDoc } from '../src/frontend/frames';

let failed = 0;
const ok = (cond: unknown, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

ok(looksRenderable('<!DOCTYPE html><html><body>hi</body></html>'), 'full document is renderable');
ok(looksRenderable('<div style="color:red">x</div>'), 'styled div is renderable');
ok(looksRenderable('<script>alert(1)</script>'), 'script is renderable');
ok(!looksRenderable('const x = 1;\nconsole.log(x)'), 'plain JS is not renderable');
ok(!looksRenderable('Just some text with a < b and c > d'), 'prose is not renderable');

ok(replaceVh('.a{min-height:100vh}').includes('var(--TH-viewport-height)'), '100vh -> viewport var');
ok(replaceVh('.a{min-height: 50vh;}').includes('calc(var(--TH-viewport-height) * 0.5)'), '50vh -> calc');
ok(replaceVh('<div style="min-height:80vh">').includes('0.8'), 'inline style vh');
ok(replaceVh('.a{height:100vh}') === '.a{height:100vh}', 'only min-height is rewritten');

const doc = buildMessageDoc('<div>hello</div>');
ok(doc.includes('window.parent.__TH__') && doc.includes('<body><div>hello</div>'), 'fragment wrapped with predefine');
const full = buildMessageDoc('<html><head><title>t</title></head><body>b</body></html>');
ok(full.indexOf('__TH__') < full.indexOf('<title>'), 'predefine runs before page scripts in <head>');
const fenced = buildScriptDoc('```js\nconsole.log(1)\n```');
ok(fenced.includes('console.log(1)') && !fenced.includes('```'), 'markdown fence stripped from scripts');
const tricky = buildScriptDoc('document.write("</script><b>")');
ok(!/<\/script><b>/.test(tricky), 'closing script tag in user code is escaped');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
