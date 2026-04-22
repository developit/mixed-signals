import {describe, expect, it} from 'vitest';
import {
  formatCallMessage,
  formatErrorMessage,
  formatNotificationMessage,
  formatResultMessage,
  parseWireMessage,
  parseWireParams,
  parseWireValue,
} from '../shared/protocol.ts';

describe('protocol', () => {
  it('formats and parses the supported wire messages', () => {
    const call = formatCallMessage(3, 'todos.create', [1, 'two']);
    expect(call).toBe('M3:todos.create:1,"two"');
    expect(parseWireMessage(call)).toEqual({
      type: 'call',
      id: 3,
      method: 'todos.create',
      payload: '1,"two"',
    });

    const notification = formatNotificationMessage('@W', [1, 2]);
    expect(notification).toBe('N:@W:1,2');
    expect(parseWireMessage(notification)).toEqual({
      type: 'notification',
      method: '@W',
      payload: '1,2',
    });

    const result = formatResultMessage(4, {ok: true});
    expect(result).toBe('R4:{"ok":true}');
    expect(parseWireMessage(result)).toEqual({
      type: 'result',
      id: 4,
      payload: '{"ok":true}',
    });

    const error = formatErrorMessage(5, {message: 'boom'});
    expect(error).toBe('E5:{"message":"boom"}');
    expect(parseWireMessage(error)).toEqual({
      type: 'error',
      id: 5,
      payload: '{"message":"boom"}',
    });
  });

  it('preserves undefined across the wire', () => {
    // Params: undefined roundtrips as undefined (not null).
    const call = formatCallMessage(1, 'm', [1, undefined, 'x']);
    expect(call).toBe('M1:m:1,{"@u":1},"x"');
    const parsedCall = parseWireMessage(call);
    const params = parseWireParams<unknown[]>(
      (parsedCall as {payload: string}).payload,
    );
    expect(params.length).toBe(3);
    expect(params[0]).toBe(1);
    expect(params[1]).toBeUndefined();
    expect(params[2]).toBe('x');
    // null stays null — the two are distinct on the wire.
    expect(parseWireParams<unknown[]>('null')).toEqual([null]);

    // Notifications: same preservation.
    const note = formatNotificationMessage('@W', [undefined, undefined]);
    const notePayload = (parseWireMessage(note) as {payload: string}).payload;
    const noteParams = parseWireParams<unknown[]>(notePayload);
    expect(noteParams.length).toBe(2);
    expect(noteParams[0]).toBeUndefined();
    expect(noteParams[1]).toBeUndefined();

    // Results: undefined roundtrips instead of becoming invalid JSON.
    const result = formatResultMessage(4, undefined);
    const resultPayload = (parseWireMessage(result) as {payload: string})
      .payload;
    expect(parseWireValue(resultPayload)).toBeUndefined();

    // Nested undefined inside a result array is preserved (no null coercion).
    const arr = formatResultMessage(5, [1, undefined, 3]);
    const arrPayload = (parseWireMessage(arr) as {payload: string}).payload;
    const revivedArr = parseWireValue<unknown[]>(arrPayload);
    expect(revivedArr.length).toBe(3);
    expect(revivedArr[0]).toBe(1);
    expect(revivedArr[1]).toBeUndefined();
    expect(revivedArr[2]).toBe(3);
  });

  it('parses params and values with empty payloads and revivers', () => {
    const reviver = (_key: string, value: unknown) => {
      if (typeof value === 'number') return value * 2;
      return value;
    };

    expect(parseWireParams('')).toEqual([]);
    expect(parseWireParams<unknown[]>('1,{"count":2}', reviver)).toEqual([
      2,
      {count: 4},
    ]);
    expect(parseWireValue<{count: number}>('{"count":2}', reviver)).toEqual({
      count: 4,
    });
  });

  it('rejects malformed wire messages', () => {
    for (const input of [
      '',
      'X',
      'M',
      'M1:todos.create',
      'Mnope:todos.create:1',
      'M1::1',
      'N1:@W:1',
      'N::',
      'R:{}',
      'Rnope:{}',
      'E:{}',
      'E1',
    ]) {
      expect(parseWireMessage(input)).toBeNull();
    }
  });
});
