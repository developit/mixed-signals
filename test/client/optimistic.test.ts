import {effect, signal} from '@preact/signals-core';
import {describe, expect, it} from 'vitest';
import {createOptimisticList} from '../../client/optimistic.ts';

interface Message {
  id: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
}

function ids(messages: readonly Message[]): string[] {
  return messages.map((message) => message.id);
}

describe('createOptimisticList', () => {
  it('does not watch the source until an optimistic item needs reconciliation', () => {
    let watchCount = 0;
    let unwatchCount = 0;
    const source = signal<Message[]>([], {
      watched() {
        watchCount++;
      },
      unwatched() {
        unwatchCount++;
      },
    });

    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    expect(watchCount).toBe(0);

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    expect(watchCount).toBe(1);
    expect(unwatchCount).toBe(0);

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'hi',
      },
    ];

    expect(watchCount).toBe(1);
    expect(unwatchCount).toBe(1);
  });

  it('keeps source pruning subscribed while optimistic entries are pending', () => {
    let watchCount = 0;
    let unwatchCount = 0;
    const source = signal<Message[]>([], {
      watched() {
        watchCount++;
      },
      unwatched() {
        unwatchCount++;
      },
    });
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    const stopValue = messages.value.subscribe(() => undefined);
    const stopPending = messages.pending.subscribe(() => undefined);

    expect(watchCount).toBe(1);
    expect(unwatchCount).toBe(0);

    stopValue();

    expect(unwatchCount).toBe(0);

    stopPending();

    expect(unwatchCount).toBe(0);

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'hi',
      },
    ];

    expect(unwatchCount).toBe(1);
  });

  it('overlays optimistic items without mutating the source signal', () => {
    const source = signal<Message[]>([
      {id: 'server-1', role: 'assistant', text: 'hello'},
    ]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    expect(ids(source.peek())).toEqual(['server-1']);
    expect(ids(messages.value.peek())).toEqual(['server-1', 'local-1']);
    expect(ids(messages.pending.peek())).toEqual(['local-1']);
  });

  it('dedupes a pending item when the server reflects the same key', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'hi',
      },
    ];

    expect(ids(messages.value.peek())).toEqual(['server-user-1']);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('does not add an optimistic item already confirmed by source', () => {
    const source = signal<Message[]>([
      {id: 'server-user-1', clientId: 'client-1', role: 'user', text: 'hi'},
    ]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    expect(ids(messages.value.peek())).toEqual(['server-user-1']);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('does not resurrect confirmed items after server removal', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    const stop = messages.value.subscribe(() => undefined);

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'hi',
      },
    ];

    expect(ids(messages.value.peek())).toEqual(['server-user-1']);
    expect(messages.pending.peek()).toEqual([]);

    source.value = [];

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);

    stop();
  });

  it('does not resurrect confirmed items after unobserved server removal', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'hi',
      },
    ];
    source.value = [];

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('keeps non-repeating server deltas while removing confirmed optimism', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'what is up?',
    });

    source.value = [
      {
        id: 'server-user-1',
        clientId: 'client-1',
        role: 'user',
        text: 'what is up?',
      },
      {id: 'assistant-1', role: 'assistant', text: 'not much'},
    ];

    expect(ids(messages.value.peek())).toEqual([
      'server-user-1',
      'assistant-1',
    ]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('rolls back a pending optimistic item', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    const operation = messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    expect(ids(messages.value.peek())).toEqual(['local-1']);

    operation.rollback();

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('rolls back from an effect without creating a signal cycle', () => {
    const source = signal<Message[]>([]);
    const failed = signal(false);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });
    const operation = messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    const stop = effect(() => {
      if (failed.value) operation.rollback();
    });

    expect(() => {
      failed.value = true;
    }).not.toThrow();

    stop();

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('keeps pruning active after a reentrant insert during removal', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });
    const operation = messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'one',
    });
    let inserted = false;

    const stop = effect(() => {
      if (messages.pending.value.length !== 0 || inserted) return;

      inserted = true;
      messages.insert({
        id: 'local-2',
        clientId: 'client-2',
        role: 'user',
        text: 'two',
      });
    });

    operation.rollback();
    stop();

    source.value = [
      {
        id: 'server-user-2',
        clientId: 'client-2',
        role: 'user',
        text: 'two',
      },
    ];
    source.value = [];

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('dedupes after full source replacement', () => {
    const source = signal<Message[]>([
      {id: 'assistant-1', role: 'assistant', text: 'hello'},
    ]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    source.value = [
      {id: 'assistant-1', role: 'assistant', text: 'hello'},
      {id: 'server-user-1', clientId: 'client-1', role: 'user', text: 'hi'},
    ];

    expect(ids(messages.value.peek())).toEqual([
      'assistant-1',
      'server-user-1',
    ]);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('uses a custom match function for server correlation ids', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.id,
      match: (serverMessage, optimisticMessage) =>
        serverMessage.clientId !== undefined &&
        serverMessage.clientId === optimisticMessage.clientId,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    source.value = [
      {id: 'server-user-1', clientId: 'client-1', role: 'user', text: 'hi'},
    ];

    expect(ids(messages.value.peek())).toEqual(['server-user-1']);
    expect(messages.pending.peek()).toEqual([]);
  });

  it('preserves multiple pending inserts in insertion order', () => {
    const source = signal<Message[]>([
      {id: 'assistant-1', role: 'assistant', text: 'hello'},
    ]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'one',
    });
    messages.insert({
      id: 'local-2',
      clientId: 'client-2',
      role: 'user',
      text: 'two',
    });

    expect(ids(messages.value.peek())).toEqual([
      'assistant-1',
      'local-1',
      'local-2',
    ]);
  });

  it('removes a specific operation', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    const first = messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'one',
    });
    messages.insert({
      id: 'local-2',
      clientId: 'client-2',
      role: 'user',
      text: 'two',
    });

    messages.remove(first);

    expect(ids(messages.value.peek())).toEqual(['local-2']);
    expect(ids(messages.pending.peek())).toEqual(['local-2']);
  });

  it('ignores remove operations from another list', () => {
    const sourceA = signal<Message[]>([]);
    const sourceB = signal<Message[]>([]);
    const messagesA = createOptimisticList(sourceA, {
      key: (message) => message.clientId ?? message.id,
    });
    const messagesB = createOptimisticList(sourceB, {
      key: (message) => message.clientId ?? message.id,
    });

    const operationA = messagesA.insert({
      id: 'local-a',
      clientId: 'client-a',
      role: 'user',
      text: 'a',
    });
    messagesB.insert({
      id: 'local-b',
      clientId: 'client-b',
      role: 'user',
      text: 'b',
    });

    messagesB.remove(operationA);

    expect(ids(messagesA.value.peek())).toEqual(['local-a']);
    expect(ids(messagesB.value.peek())).toEqual(['local-b']);
  });

  it('clears pending items on dispose', () => {
    const source = signal<Message[]>([]);
    const messages = createOptimisticList(source, {
      key: (message) => message.clientId ?? message.id,
    });

    messages.insert({
      id: 'local-1',
      clientId: 'client-1',
      role: 'user',
      text: 'hi',
    });

    messages.dispose();

    expect(messages.value.peek()).toEqual([]);
    expect(messages.pending.peek()).toEqual([]);
  });
});
