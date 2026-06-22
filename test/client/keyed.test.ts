import {computed, effect, type Signal, signal} from '@preact/signals-core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {linkSource, optimistic, type ReflectedSignal} from '../../client/optimistic.ts';
import {RPCClient} from '../../client/rpc.ts';
import type {Transport} from '../../shared/protocol.ts';

const settle = () => Promise.resolve().then(() => Promise.resolve());
const silent: Transport = {send() {}, onMessage() {}};

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cid?: string;
}

/** Synchronous reflected-signal harness with frame recording. */
function reflected(id: number, initial: Msg[]) {
  const {reflection} = new RPCClient(silent);
  const source = reflection.getOrCreateSignal(id, initial) as Signal<Msg[]>;
  const view = linkSource(
    computed(() => source.value),
    source,
  ) as ReflectedSignal<Msg[]>;
  const frames: Msg[][] = [];
  const stop = effect(() => {
    frames.push(view.value);
  });
  return {
    view,
    frames,
    stop,
    push: (delta: unknown, mode?: string) => reflection.handleUpdate(id, delta, mode),
  };
}

const ids = (f: Msg[]) => f.map((m) => m.id);
const userTexts = (f: Msg[], text: string) =>
  f.filter((m) => m.role === 'user' && m.text === text).length;

afterEach(() => vi.useRealTimers());

const BASE: Msg[] = [
  {id: 'm0', role: 'user', text: 'hello'},
  {id: 'm1', role: 'assistant', text: 'hi'},
];

describe('keyed optimistic — insert', () => {
  it('echoed key: no duplicate, no drift below assistant, settles to truth', async () => {
    const {view, frames, stop, push} = reflected(1, BASE);
    const action = Promise.resolve();

    optimistic(action, (tx) => {
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
      });
    });

    // turn: server echoes the user message (carrying cid), then streams assistant
    push([{id: 'srvU', role: 'user', text: 'new', cid: 'c1'}], 'append');
    push([{id: 'asst', role: 'assistant', text: 'thinking'}], 'append');
    await action;
    await settle();
    stop();

    // never a duplicate "new" user message in any rendered frame
    expect(Math.max(...frames.map((f) => userTexts(f, 'new')))).toBe(1);
    // never a frame where the optimistic user msg drifted below the assistant
    const drifted = frames.some((f) => {
      const u = f.findIndex((m) => m.text === 'new');
      const a = f.findIndex((m) => m.id === 'asst');
      return u !== -1 && a !== -1 && a < u;
    });
    expect(drifted).toBe(false);
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'srvU', 'asst']);
  });

  it('requires an action for inserts that may need action-settle cleanup', () => {
    const {view} = reflected(1, BASE);

    expect(() =>
      optimistic(undefined, (tx) => {
        tx.update({
          signal: view,
          transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
          key: (m) => m.cid ?? m.id,
        });
      }),
    ).toThrow(TypeError);
  });

  it('concurrent inserts, server confirms the SECOND first: order preserved, no dup', () => {
    const {view, push} = reflected(1, BASE);

    const a = new Promise<never>(() => {});
    const b = new Promise<never>(() => {});

    optimistic(a, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'A', role: 'user' as const, text: 'A', cid: 'cA'}],
        key: (m) => m.cid ?? m.id,
      }),
    );
    optimistic(b, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'B', role: 'user' as const, text: 'B', cid: 'cB'}],
        key: (m) => m.cid ?? m.id,
      }),
    );
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'A', 'B']);

    // out-of-order confirmation: B's echo lands first
    push([{id: 'srvB', role: 'user', text: 'B', cid: 'cB'}], 'append');
    const afterB = ids(view.peek());
    push([{id: 'srvA', role: 'user', text: 'A', cid: 'cA'}], 'append');
    const afterA = ids(view.peek());

    // A stays anchored at its index (NOT re-appended after srvB) -> no reorder
    // of the still-pending optimistic item.
    expect(afterB).toEqual(['m0', 'm1', 'A', 'srvB']);
    // Final state is server truth: the server appended srvB before srvA because
    // B confirmed first. We converge to exactly that, with no duplicates.
    expect(afterA).toEqual(['m0', 'm1', 'srvB', 'srvA']);
    expect(view.peek().filter((m) => m.text === 'A')).toHaveLength(1);
    expect(view.peek().filter((m) => m.text === 'B')).toHaveLength(1);
  });

  it('unrelated server delta stays visible underneath a pending insert', () => {
    const {view, push} = reflected(1, BASE);

    optimistic(new Promise<never>(() => {}), (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
      }),
    );
    // a DIFFERENT message arrives (no matching cid) — must remain visible, patch stays
    push([{id: 'other', role: 'assistant', text: 'ping'}], 'append');

    const now = ids(view.peek());
    expect(now).toContain('other'); // unrelated delta visible
    expect(now).toContain('tmp'); // optimistic insert still layered
    expect(now).toHaveLength(4); // no duplication
    // index-anchored: the optimistic item holds its position (index 2) rather
    // than floating to the end, so it precedes the later unrelated message.
    expect(now).toEqual(['m0', 'm1', 'tmp', 'other']);
  });

  it('no echoed key degrades gracefully: no drift, settles on action (one dup frame ok)', async () => {
    const {view, frames, stop, push} = reflected(1, BASE);
    const action = Promise.resolve();

    optimistic(action, (tx) => {
      // optimistic item has cid, but server echo will NOT carry it
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
      });
    });
    push([{id: 'srvU', role: 'user', text: 'new'}], 'append'); // no cid echoed
    push([{id: 'asst', role: 'assistant', text: 'thinking'}], 'append');

    // before settle: dup exists, but tmp did NOT drift below the assistant
    const driftedBeforeSettle = frames.some((f) => {
      const u = f.findIndex((m) => m.id === 'tmp');
      const a = f.findIndex((m) => m.id === 'asst');
      return u !== -1 && a !== -1 && a < u;
    });
    expect(driftedBeforeSettle).toBe(false);

    await action;
    await settle();
    stop();
    // action settle cleans up the un-confirmed optimistic item -> server truth
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'srvU', 'asst']);
  });

  it('rejects a key function that returns a non-primitive value', () => {
    const {view} = reflected(1, BASE);

    expect(() =>
      optimistic(Promise.resolve(), (tx) => {
        tx.update({
          signal: view,
          transform: (m) => m.slice(1),
          key: (m) => ({id: m.id}) as unknown as PropertyKey,
        });
      }),
    ).toThrow(TypeError);
  });

  it('rejects duplicate keys in the optimistic projection', () => {
    const {view} = reflected(1, BASE);

    expect(() =>
      optimistic(Promise.resolve(), (tx) => {
        tx.update({
          signal: view,
          transform: (m) => [...m, {id: 'm1', role: 'user' as const, text: 'duplicate'}],
          key: (m) => m.id,
        });
      }),
    ).toThrow(TypeError);
  });
});

describe('keyed optimistic — echoed (source-driven, action rolls back only on failure)', () => {
  const seenContinuously = (frames: Msg[][], text: string) => {
    const appeared = frames.map((f) => f.some((m) => m.text === text));
    const first = appeared.indexOf(true);
    return first !== -1 && appeared.slice(first).every(Boolean);
  };

  it('a successful action settling before the echo does not remove-and-re-add the item', async () => {
    const {view, frames, stop, push} = reflected(1, BASE);
    const action = Promise.resolve();

    optimistic(action, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
        echoed: true,
      }),
    );

    await action;
    await settle();
    expect(userTexts(view.peek(), 'new')).toBe(1);

    push([{id: 'srvU', role: 'user', text: 'new', cid: 'c1'}], 'append');
    stop();

    expect(seenContinuously(frames, 'new')).toBe(true);
    expect(Math.max(...frames.map((f) => userTexts(f, 'new')))).toBe(1);
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'srvU']);
  });

  it('the echo confirms the insert in place, and the later settling action is a no-op', async () => {
    const {view, frames, stop, push} = reflected(1, BASE);
    const action = Promise.resolve();

    optimistic(action, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
        echoed: true,
      }),
    );

    push([{id: 'srvU', role: 'user', text: 'new', cid: 'c1'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'srvU']);

    await action;
    await settle();
    stop();

    expect(seenContinuously(frames, 'new')).toBe(true);
    expect(frames.some((f) => userTexts(f, 'new') > 1)).toBe(false);
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'srvU']);
  });

  it('a rejected action rolls the optimistic item back', async () => {
    const {view, push} = reflected(1, BASE);
    let reject!: (error: unknown) => void;
    const action = new Promise((_resolve, rej) => {
      reject = rej;
    });

    optimistic(action, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
        echoed: true,
      }),
    );
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'tmp']);

    reject(new Error('server said no'));
    await action.catch(() => {});
    await settle();

    expect(ids(view.peek())).toEqual(['m0', 'm1']);

    push([{id: 'm2', role: 'user', text: 'fresh'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm2']);
  });
});

describe('keyed optimistic — delete & replace', () => {
  it('delete by existing server id: hidden immediately, confirmed on reflect', () => {
    const m2: Msg = {id: 'm2', role: 'user', text: 'bye'};
    const start: Msg[] = [...BASE, m2];
    const {view, push} = reflected(1, start);

    optimistic(undefined, (tx) =>
      tx.update({signal: view, transform: (m) => m.filter((x) => x.id !== 'm2'), key: (m) => m.id}),
    );
    expect(ids(view.peek())).toEqual(['m0', 'm1']); // optimistically gone

    // unrelated delta first — deletion must stay applied (base still has m2)
    push([{id: 'm3', role: 'assistant', text: 'later'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm3']); // m2 still hidden

    // server reflects the removal as a full-array replace (no splice emitted today)
    push([BASE[0], BASE[1], {id: 'm3', role: 'assistant', text: 'later'}], undefined);
    expect(view.peek().some((m) => m.id === 'm2')).toBe(false);

    // patch is confirmed+dropped: a later unrelated delta renders straight from base
    push([{id: 'm4', role: 'user', text: 'again'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm3', 'm4']);
  });

  it('replace by id: overlays new content until the server converges', () => {
    const {view, push} = reflected(1, BASE);

    const edited: Msg = {id: 'm1', role: 'assistant', text: 'edited'};
    optimistic(undefined, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => m.map((x) => (x.id === 'm1' ? {...x, text: 'edited'} : x)),
        key: (m) => m.id,
      }),
    );
    expect(view.peek().find((m) => m.id === 'm1')!.text).toBe('edited');

    // unrelated delta: replacement must persist
    push([{id: 'm2', role: 'user', text: 'q'}], 'append');
    expect(view.peek().find((m) => m.id === 'm1')!.text).toBe('edited');

    // server converges to the same edit (full-array replace) -> confirm + drop
    push([BASE[0], edited, {id: 'm2', role: 'user', text: 'q'}], undefined);
    expect(view.peek().find((m) => m.id === 'm1')!.text).toBe('edited');

    // confirmed: subsequent unrelated delta renders straight from base
    push([{id: 'm3', role: 'assistant', text: 'r'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('move by existing id: reorders immediately and drops when server order matches', () => {
    const m2: Msg = {id: 'm2', role: 'user', text: 'bye'};
    const start: Msg[] = [...BASE, m2];
    const {view, push} = reflected(1, start);

    optimistic(undefined, (tx) =>
      tx.update({signal: view, transform: (m) => [m[2], m[0], m[1]], key: (m) => m.id}),
    );
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'm1']);

    push([m2, BASE[0], BASE[1]], undefined);
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'm1']);

    push([{id: 'm3', role: 'assistant', text: 'later'}], 'append');
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'm1', 'm3']);
  });

  it('can confirm replacement of model-shaped items by signal values', () => {
    const before = [
      {id: signal('m0'), text: signal('hello')},
      {id: signal('m1'), text: signal('hi')},
    ];
    const {reflection} = new RPCClient(silent);
    const source = reflection.getOrCreateSignal(2, before) as Signal<typeof before>;
    const view = linkSource(
      computed(() => source.value),
      source,
    ) as ReflectedSignal<typeof before>;

    optimistic(undefined, (tx) =>
      tx.update({
        signal: view,
        transform: (items) =>
          items.map((item) =>
            item.id.value === 'm1'
              ? {id: signal('m1'), text: signal('edited')}
              : item,
          ),
        key: (m) => m.id.value,
      }),
    );
    expect(view.peek()[1].text.value).toBe('edited');

    reflection.handleUpdate(
      2,
      [before[0], {id: signal('m1'), text: signal('edited')}],
      undefined,
    );
    reflection.handleUpdate(
      2,
      [{id: signal('m2'), text: signal('later')}],
      'append',
    );

    expect(view.peek().map((item) => item.text.value)).toEqual([
      'hello',
      'edited',
      'later',
    ]);
  });
});

describe('keyed optimistic — guards and reconnect', () => {
  it('rejects array updates without a key', () => {
    const {view} = reflected(1, BASE);

    expect(() =>
      optimistic(Promise.resolve(), (tx) => {
        // @ts-expect-error array updates must declare a key
        tx.update({signal: view, transform: (m) => m.slice(1)});
      }),
    ).toThrow(TypeError);
  });

  it('rejects keyed options for non-array values', () => {
    const {reflection} = new RPCClient(silent);
    const source = reflection.getOrCreateSignal(10, 'title') as Signal<string>;
    const view = linkSource(
      computed(() => source.value),
      source,
    ) as ReflectedSignal<string>;

    expect(() =>
      optimistic(Promise.resolve(), (tx) => {
        // @ts-expect-error non-array values cannot use list keys
        tx.set({signal: view, value: 'next', key: (item) => item});
      }),
    ).toThrow(TypeError);
  });

  it('rolls back live overlays when reflection resets on reconnect', () => {
    const client = new RPCClient(silent);
    const source = client.reflection.getOrCreateSignal(1, [
      {id: 'm0', role: 'user' as const, text: 'hello'},
    ]) as Signal<Msg[]>;
    const view = linkSource(
      computed(() => source.value),
      source,
    ) as ReflectedSignal<Msg[]>;

    optimistic(new Promise<never>(() => {}), (tx) => {
      tx.update({
        signal: view,
        transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new', cid: 'c1'}],
        key: (m) => m.cid ?? m.id,
      });
    });
    expect(ids(view.peek())).toEqual(['m0', 'tmp']);

    client.reflection.reset();

    expect(ids(view.peek())).toEqual(['m0']);
  });

  it('rejects an array value with no key even when the base is not yet an array', () => {
    const {reflection} = new RPCClient(silent);
    // Typed as an array but seeded null at runtime (e.g. before the first push).
    const source = reflection.getOrCreateSignal(20, null) as Signal<Msg[]>;
    const view = linkSource(
      computed(() => source.value),
      source,
    ) as ReflectedSignal<Msg[]>;

    expect(() =>
      optimistic(Promise.resolve(), (tx) =>
        // @ts-expect-error array changes must declare a key
        tx.set({signal: view, value: [{id: 'a', role: 'user', text: 'a'}]}),
      ),
    ).toThrow(TypeError);
  });
});

describe('keyed optimistic — atomicity', () => {
  it('rolls back ops recorded before the callback throws, leaving no stuck overlay', () => {
    const {view, push} = reflected(1, BASE);

    expect(() =>
      optimistic(new Promise<never>(() => {}), (tx) => {
        tx.update({
          signal: view,
          transform: (m) => [...m, {id: 'tmp', role: 'user' as const, text: 'new'}],
          key: (m) => m.id,
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // the earlier op was rolled back -> the base is intact
    expect(ids(view.peek())).toEqual(['m0', 'm1']);

    // overlay detached: a later server delta renders straight from the base
    push([{id: 'm2', role: 'assistant', text: 'later'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm2']);
  });
});

describe('keyed optimistic — combined ops & robust reconciliation', () => {
  it('reconciles a combined insert and reorder in one transform', () => {
    const m2: Msg = {id: 'm2', role: 'user', text: 'bye'};
    const {view, push} = reflected(1, [...BASE, m2]); // m0, m1, m2

    optimistic(new Promise<never>(() => {}), (tx) =>
      tx.update({
        signal: view,
        // move m2 to the front AND insert a new keyed item
        transform: (m) => [
          m[2],
          m[0],
          {id: 'new', role: 'user' as const, text: 'n', cid: 'cN'},
          m[1],
        ],
        key: (m) => m.cid ?? m.id,
      }),
    );
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'new', 'm1']);

    // server reflects the same order, echoing cid for the new item
    push(
      [
        m2,
        BASE[0],
        {id: 'srvNew', role: 'user', text: 'n', cid: 'cN'},
        BASE[1],
      ],
      undefined,
    );
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'srvNew', 'm1']);
  });

  it('confirms a replace once the server diverges from the pre-edit value (normalization)', () => {
    const {view, push} = reflected(1, BASE);

    optimistic(undefined, (tx) =>
      tx.update({
        signal: view,
        transform: (m) => m.map((x) => (x.id === 'm1' ? {...x, text: 'edited'} : x)),
        key: (m) => m.id,
      }),
    );
    expect(view.peek().find((m) => m.id === 'm1')!.text).toBe('edited');

    // server stores a NORMALIZED value that never deep-equals the optimistic guess
    push([BASE[0], {id: 'm1', role: 'assistant', text: 'EDITED (server)'}], undefined);
    expect(view.peek().find((m) => m.id === 'm1')!.text).toBe('EDITED (server)');

    // confirmed + dropped: a later unrelated delta renders straight from base
    push([{id: 'm2', role: 'user', text: 'q'}], 'append');
    expect(ids(view.peek())).toEqual(['m0', 'm1', 'm2']);
  });

  it('confirms a move by relative order when the server inserts between the anchors', () => {
    const m2: Msg = {id: 'm2', role: 'user', text: 'bye'};
    const {view, push} = reflected(1, [...BASE, m2]); // m0, m1, m2

    optimistic(undefined, (tx) =>
      tx.update({signal: view, transform: (m) => [m[2], m[0], m[1]], key: (m) => m.id}),
    );
    expect(ids(view.peek())).toEqual(['m2', 'm0', 'm1']);

    // server reflects the move but slips a new item between m2 and its anchor m0.
    // Exact-neighbour matching would never confirm; relative order does.
    push([m2, {id: 'x', role: 'assistant', text: 'x'}, BASE[0], BASE[1]], undefined);
    expect(ids(view.peek())).toEqual(['m2', 'x', 'm0', 'm1']);

    // confirmed + dropped: subsequent unrelated delta renders straight from base
    push([{id: 'm9', role: 'user', text: 'z'}], 'append');
    expect(ids(view.peek())).toEqual(['m2', 'x', 'm0', 'm1', 'm9']);
  });
});
