import { createWorldbookApi, toJsrEntry, toLumiverseEntry } from '../src/frontend/worldbook';

let failed = 0;
const ok = (cond: unknown, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

// ---- pure conversion
const jsr: any = {
  uid: 7,
  name: 'Tavern',
  enabled: true,
  strategy: { type: 'selective', keys: ['inn', /bar(s)?/i], keys_secondary: { logic: 'not_any', keys: ['closed'] }, scan_depth: 3 },
  position: { type: 'at_depth', role: 'user', depth: 2, order: 50 },
  content: 'A cozy inn.',
  probability: 80,
  recursion: { prevent_incoming: true, prevent_outgoing: false, delay_until: null },
  effect: { sticky: 2, cooldown: null, delay: null },
};
const lumi = toLumiverseEntry(jsr, { partial: false });
ok(lumi.selective === true && lumi.constant === false, 'selective strategy flags');
ok(lumi.key[1] === '/bar(s)?/i' && lumi.use_regex === true, 'RegExp key serialized and use_regex set');
ok(lumi.selective_logic === 1, 'not_any -> Lumiverse 1');
ok(lumi.position === 4 && lumi.role === 'user' && lumi.depth === 2 && lumi.order_value === 50, 'position mapping');
ok(lumi.exclude_recursion === true && lumi.sticky === 2 && lumi.cooldown === 0, 'recursion/effect mapping');
ok(toLumiverseEntry({ content: 'x' }, { partial: true }).content === 'x' && Object.keys(toLumiverseEntry({ content: 'x' }, { partial: true })).length === 1, 'partial update emits only given fields');

const back = toJsrEntry({ ...lumi, id: 'e1', uid: '7' }, () => 7);
ok(back.strategy.keys_secondary.logic === 'not_any', 'logic round-trips');
ok(back.strategy.keys[1] instanceof RegExp, 'regex key round-trips');
ok(back.position.type === 'at_depth' && back.probability === 80, 'position/probability round-trip');
ok(back.effect.sticky === 2 && back.effect.cooldown === null, 'null effects round-trip');

// ---- API against a fake backend
const books = new Map<string, { id: string; name: string; entries: any[] }>();
let seq = 0;
const calls: string[] = [];
const rpc: any = {
  call: async (m: string, a: any) => {
    calls.push(m);
    switch (m) {
      case 'wb.listBooks': return [...books.values()].map(b => ({ id: b.id, name: b.name }));
      case 'wb.getGlobal': return [];
      case 'wb.createBook': { const b = { id: `b${++seq}`, name: a.name, entries: [] as any[] }; books.set(b.id, b); return { id: b.id, name: b.name }; }
      case 'wb.listEntries': return books.get(a.bookId)!.entries;
      case 'wb.createEntry': { const e = { id: `e${++seq}`, ...a.data }; books.get(a.bookId)!.entries.push(e); return e; }
      case 'wb.updateEntry': { for (const b of books.values()) { const e = b.entries.find(x => x.id === a.entryId); if (e) Object.assign(e, a.data); } return true; }
      case 'wb.deleteEntry': { for (const b of books.values()) b.entries = b.entries.filter(x => x.id !== a.entryId); return true; }
      case 'wb.deleteBook': books.delete(a.bookId); return true;
    }
  },
};
const mirror: any = { worldbooks: new Map(), globalWorldbookIds: [], characterWorldbookIds: [], characterId: null };

(async () => {
  const { fns, refreshBooks } = createWorldbookApi(rpc, mirror);
  await refreshBooks();
  ok(fns.getWorldbookNames().length === 0, 'starts empty');
  ok((await fns.createWorldbook('Lore', [{ name: 'A', content: 'a' }, { name: 'B', content: 'b' }])) === true, 'createWorldbook');
  ok(fns.getWorldbookNames().includes('Lore'), 'names cache updated synchronously');
  ok((await fns.createWorldbook('Lore')) === false, 'duplicate create returns false');
  let wb = await fns.getWorldbook('Lore');
  ok(wb.length === 2 && wb[0].name === 'A' && wb[0].uid !== wb[1].uid, 'entries created with distinct uids');

  const r = await fns.createWorldbookEntries('Lore', [{ name: 'C', content: 'c' }]);
  ok(r.new_entries.length === 1 && r.new_entries[0].name === 'C' && r.worldbook.length === 3, 'createWorldbookEntries');

  wb = await fns.updateWorldbookWith('Lore', w => w.map(e => (e.name === 'A' ? { ...e, content: 'A2' } : e)));
  ok(wb.find(e => e.name === 'A')!.content === 'A2' && wb.length === 3, 'updateWorldbookWith edits in place');

  const del = await fns.deleteWorldbookEntries('Lore', e => e.name === 'B');
  ok(del.deleted_entries.length === 1 && del.worldbook.length === 2, 'deleteWorldbookEntries');

  await fns.replaceWorldbook('Lore', [{ uid: wb[0].uid, name: 'A', content: 'only' }]);
  wb = await fns.getWorldbook('Lore');
  ok(wb.length === 1 && wb[0].content === 'only', 'replaceWorldbook removes unlisted entries');

  ok((await fns.deleteWorldbook('Lore')) === true && !fns.getWorldbookNames().includes('Lore'), 'deleteWorldbook');
  let threw = false;
  try { await fns.getWorldbook('Nope'); } catch { threw = true; }
  ok(threw, 'unknown book throws');

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
