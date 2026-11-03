import { createApi } from '../src/frontend/api';
import { EventBus } from '../src/frontend/events';
import { Mirror } from '../src/frontend/mirror';
import { normalizeTree } from '../src/frontend/scripts';

const writes: any[] = [];
const rpc: any = {
  call: async (method: string, args: any) => {
    if (method === 'vars.snapshot') return { chat: { a: 1 }, global: {}, character: {}, preset: {} };
    if (method === 'vars.read') return {};
    if (method === 'chat.create') return args.messages.map((_: any, i: number) => `new${i}`);
    writes.push([method, args]);
    return true;
  },
  newId: () => 'id1',
  onPush: () => () => undefined,
};
const msgs = [0, 1, 2, 3].map(i => ({
  id: `m${i}`, index_in_chat: i, is_user: i % 2 === 0, name: i % 2 ? 'Bot' : 'Me', content: `msg ${i}`,
  swipe_id: 0, swipes: [`msg ${i}`], extra: i === 1 ? { hidden: true } : {},
}));
const ctx: any = {
  getActiveChat: () => ({ chatId: 'c1', characterId: 'ch1' }),
  messages: { list: async () => msgs },
  characters: { get: async () => ({ name: 'Bot', description: 'desc' }) },
  events: { on: () => () => undefined },
  manifest: { identifier: 'tavern_helper' },
};

let failed = 0;
const ok = (cond: unknown, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

(async () => {
  const mirror = new Mirror(ctx, rpc);
  await mirror.ready;
  const bus = new EventBus();
  const api = createApi({ ctx, rpc, mirror, bus, log: () => undefined });
  const a = { ...api.shared, ...api.bindFor({ owner: 's', scriptId: 'sc1', scriptName: 'S' }) } as any;

  ok(a.getLastMessageId() === 3, 'getLastMessageId');
  ok(a.getCurrentCharacterName() === 'Bot', 'character name');
  ok(a.getChatMessages('0-3').length === 4, 'range 0-3');
  ok(a.getChatMessages(-1)[0].message === 'msg 3', 'negative index');
  ok(a.getChatMessages('0-3', { hide_state: 'hidden' }).length === 1, 'hide_state filter');
  ok(a.getChatMessages('0-3', { role: 'user' }).length === 2, 'role filter');
  ok(a.getChatMessages(0, { include_swipes: true })[0].swipes.length === 1, 'swipes shape');

  ok(a.getVariables({ type: 'chat' }).a === 1, 'chat var from snapshot');
  a.insertOrAssignVariables({ b: { c: 2 } }, { type: 'chat' });
  ok(a.getVariables({ type: 'chat' }).b.c === 2, 'insertOrAssign nested (sync)');
  a.insertVariables({ a: 99, d: 4 }, { type: 'chat' });
  const v = a.getVariables({ type: 'chat' });
  ok(v.a === 1 && v.d === 4, 'insertVariables keeps existing');
  const del = a.deleteVariable('b.c', { type: 'chat' });
  ok(del.delete_occurred && !('c' in a.getVariables({ type: 'chat' }).b), 'deleteVariable path');
  const r = a.updateVariablesWith((x: any) => ({ ...x, z: 1 }), { type: 'chat' });
  ok(r.z === 1, 'updateVariablesWith');
  await mirror.flush();
  ok(writes.filter(w => w[0] === 'vars.write').length >= 4, 'writes flushed to backend in order');

  let got: any;
  a.eventOn('foo', (x: any) => (got = x));
  await a.eventEmit('foo', 42);
  ok(got === 42, 'eventOn/eventEmit');
  a.eventClearAll();
  got = undefined;
  await a.eventEmit('foo', 1);
  ok(got === undefined, 'eventClearAll drops owner listeners');

  ok(a.getScriptId() === 'sc1' && a.getButtonEvent('go') === 'sc1_go', 'script identity helpers');
  ok(a.substitudeMacros('{{user}} & {{char}} #{{lastMessageId}}') === 'Me & Bot #3', 'macro substitution');

  await a.createChatMessages([{ role: 'assistant', message: 'hi' }]);
  ok(writes.length > 0, 'createChatMessages calls backend');
  await a.setChatMessages([{ message_id: 2, message: 'edited', is_hidden: true }]);
  const upd = writes.find(w => w[0] === 'chat.update');
  ok(upd && upd[1].updates[0].messageId === 'm2' && upd[1].updates[0].patch.content === 'edited' && upd[1].updates[0].hidden === true, 'setChatMessages maps index -> id');

  const tree: any = normalizeTree({ type: 'script', name: 'x', content: 'y', enabled: true, button: { buttons: [{ name: 'b', visible: true }] } });
  ok(tree.id && tree.button.buttons[0].name === 'b' && tree.export_with.data === true, 'JSR script import normalizes');

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
