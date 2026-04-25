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

    // Empty params remain compact and parse correctly.
    const emptyCall = formatCallMessage(6, 'noop', []);
    expect(emptyCall).toBe('M6:noop:');
    expect(parseWireMessage(emptyCall)).toEqual({
      type: 'call',
      id: 6,
      method: 'noop',
      payload: '',
    });

    // Complex params survive comma-heavy payloads.
    const complex = formatCallMessage(7, 'merge', [
      {a: [1, 2, 3], text: 'x,y'},
      {nested: {ok: true}},
    ]);
    const parsedComplex = parseWireMessage(complex);
    expect(parsedComplex?.type).toBe('call');
    expect(parseWireParams(parsedComplex!.payload)).toEqual([
      {a: [1, 2, 3], text: 'x,y'},
      {nested: {ok: true}},
    ]);
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
