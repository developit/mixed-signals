import {describe, expect, it} from 'vitest';
import {optimistic, type OptimisticConflict} from '../../client/optimistic.ts';
import {
  Board,
  boardOf,
  type BoardRoot,
  type Card,
  BoardModel,
  Harness,
  record,
} from '../harness.ts';

async function twoClients() {
  const harness = new Harness<BoardRoot>({board: new Board()}, (rpc) =>
    rpc.registerModel('Board', Board),
  );
  const a = await harness.connect('a', (client) => client.registerModel('Board', BoardModel));
  const b = await harness.connect('b', (client) => client.registerModel('Board', BoardModel));
  return {harness, a, b};
}

const editCard = (cards: readonly Card[], id: string, text: string): Card[] =>
  cards.map((card) => (card.id === id ? {...card, text} : card));

describe('concurrency — real wire, multiple clients', () => {
  it('propagates one client edit to another', async () => {
    const {harness, a, b} = await twoClients();
    const seen = record(() => boardOf(a).cards.value);
    record(() => boardOf(b).cards.value);
    await harness.settle();

    boardOf(a).addCard({id: 'c1', text: 'hi'});
    await harness.settle();

    boardOf(b).editCard('c1', 'bye');
    await harness.settle();

    expect(boardOf(a).cards.peek()).toEqual([{id: 'c1', text: 'BYE'}]);
    seen.stop();
  });

  it('does not silently lose an optimistic edit to a concurrent write, and confirms by id', async () => {
    const {harness, a, b} = await twoClients();
    record(() => boardOf(a).cards.value);
    record(() => boardOf(b).cards.value);
    await harness.settle();

    boardOf(a).addCard({id: 'c1', text: 'hi'});
    await harness.settle();
    expect(boardOf(a).cards.peek()).toEqual([{id: 'c1', text: 'hi'}]);

    const conflicts: OptimisticConflict[] = [];
    const action = boardOf(a).editCard('c1', 'mine');
    const handle = optimistic(
      action,
      (tx) =>
        tx.update({
          signal: boardOf(a).cards,
          transform: (cards) => editCard(cards, 'c1', 'mine'),
          key: (card) => card.id,
        }),
      {onConflict: (conflict) => conflicts.push(conflict)},
    );
    expect(boardOf(a).cards.peek()[0].text).toBe('mine');

    // B's concurrent write reaches A before A's own edit is confirmed.
    boardOf(b).editCard('c1', 'theirs');
    await b.flushOut();
    await a.flushIn();

    expect(conflicts).toEqual([
      {key: 'c1', optimistic: {id: 'c1', text: 'mine'}, server: {id: 'c1', text: 'THEIRS'}},
    ]);
    expect(boardOf(a).cards.peek()[0].text).toBe('mine');
    expect(handle.state).toBe('pending');

    // A's edit is delivered and confirmed by call id (server normalized it).
    await a.flushOut();
    await harness.settle();
    await action;

    expect(boardOf(a).cards.peek()[0].text).toBe('MINE');
    expect(handle.state).toBe('settled');
  });

  it('does not report a conflict for the server normalizing the caller own edit', async () => {
    const {harness, a} = await twoClients();
    record(() => boardOf(a).title.value);
    await harness.settle();

    const conflicts: OptimisticConflict[] = [];
    const action = boardOf(a).rename('  hello  ');
    const handle = optimistic(action, (tx) => tx.set({signal: boardOf(a).title, value: '  hello  '}), {
      onConflict: (conflict) => conflicts.push(conflict),
    });
    expect(boardOf(a).title.peek()).toBe('  hello  ');

    // Deliver only the confirming delta, not the reply: confirmation is by id,
    // so the normalized value shows while the action is still pending.
    await a.flushOut();
    await a.flushIn(1);

    expect(boardOf(a).title.peek()).toBe('hello');
    expect(handle.state).toBe('pending');
    expect(conflicts).toEqual([]);

    await harness.settle();
    await action;
    expect(handle.state).toBe('settled');
  });

  it('lands concurrent optimistic inserts from two clients with no duplicates', async () => {
    const {harness, a, b} = await twoClients();
    record(() => boardOf(a).cards.value);
    record(() => boardOf(b).cards.value);
    await harness.settle();

    const actionA = boardOf(a).addCard({id: 'a1', text: 'A'});
    optimistic(actionA, (tx) =>
      tx.update({
        signal: boardOf(a).cards,
        transform: (cards) => [...cards, {id: 'a1', text: 'A'}],
        key: (card) => card.id,
        echoed: true,
      }),
    );

    const actionB = boardOf(b).addCard({id: 'b1', text: 'B'});
    optimistic(actionB, (tx) =>
      tx.update({
        signal: boardOf(b).cards,
        transform: (cards) => [...cards, {id: 'b1', text: 'B'}],
        key: (card) => card.id,
        echoed: true,
      }),
    );

    await harness.settle();
    await Promise.all([actionA, actionB]);

    const idsA = boardOf(a).cards.peek().map((card) => card.id).sort();
    const idsB = boardOf(b).cards.peek().map((card) => card.id).sort();
    expect(idsA).toEqual(['a1', 'b1']);
    expect(idsB).toEqual(['a1', 'b1']);
  });

  it('coalesces multiple signal writes in one call into a single update', async () => {
    const {harness, a} = await twoClients();
    const seen = record(() => boardOf(a).cards.value);
    await harness.settle();

    a.rpc.call('0#board.addCardsTwice', [
      {id: 'x', text: 'X'},
      {id: 'y', text: 'Y'},
    ]);
    await harness.settle();

    expect(seen.frames).toEqual([
      [],
      [
        {id: 'x', text: 'X'},
        {id: 'y', text: 'Y'},
      ],
    ]);
    seen.stop();
  });
});
