import {describe, expect, it} from 'vitest';
import {
  hydrateTree,
  isTransferable,
  PeerCodec,
  substituteBrandsAndCollectTransferables,
} from '../shared/codec.ts';
import {
  HANDLE_MARKER,
  type RawTransport,
  type StringTransport,
  type TransportContext,
  type WireMessage,
} from '../shared/protocol.ts';
import {BRAND_REMOTE, type HandleKind, type RemoteBrand} from '../shared/brand.ts';

function makeStringTransport() {
  let handler: ((data: {toString(): string}) => void) | undefined;
  const sent: string[] = [];
  const transport: StringTransport = {
    send(data) {
      sent.push(data);
    },
    onMessage(cb) {
      handler = cb;
    },
  };
  return {transport, sent, deliver: (d: string) => handler?.({toString: () => d})};
}

function makeRawTransport() {
  let handler:
    | ((data: unknown, ctx?: TransportContext) => void | Promise<void>)
    | undefined;
  const sent: {data: unknown; ctx?: TransportContext}[] = [];
  const transport: RawTransport = {
    mode: 'raw',
    send(data, ctx) {
      sent.push({data, ctx});
    },
    onMessage(cb) {
      handler = cb;
    },
  };
  return {
    transport,
    sent,
    deliver: (d: unknown, ctx?: TransportContext) => handler?.(d, ctx),
  };
}

describe('PeerCodec', () => {
  it('string mode: encodes WireMessage to framed string', () => {
    const {transport, sent} = makeStringTransport();
    const codec = new PeerCodec(transport);
    codec.send({type: 'call', id: 1, method: 'foo', params: [1, 'two']});
    expect(sent[0]).toBe('M1:foo:1,"two"');
  });

  it('string mode: decodes framed string to WireMessage', () => {
    const {transport, deliver} = makeStringTransport();
    const codec = new PeerCodec(transport);
    const received: WireMessage[] = [];
    codec.onMessage((m) => {
      received.push(m);
    });
    deliver('M1:foo:1,"two"');
    expect(received[0]).toEqual({
      type: 'call',
      id: 1,
      method: 'foo',
      params: [1, 'two'],
    });
  });

  it('raw mode: passes WireMessage through the transport unchanged', () => {
    const {transport, sent} = makeRawTransport();
    const codec = new PeerCodec(transport);
    codec.send({type: 'result', id: 7, value: {ok: true}});
    expect(sent[0].data).toEqual({type: 'result', id: 7, value: {ok: true}});
  });

  it('raw mode: forwards ctx with transferables', () => {
    const {transport, sent} = makeRawTransport();
    const codec = new PeerCodec(transport);
    const buf = new ArrayBuffer(8);
    codec.send(
      {type: 'notification', method: 'x', params: [buf]},
      {transfer: [buf]},
    );
    expect(sent[0].ctx?.transfer?.[0]).toBe(buf);
  });

  it('raw mode: hydrates @H markers via the revive callback', () => {
    const {transport, deliver} = makeRawTransport();
    const resolved: unknown[] = [];
    const codec = new PeerCodec(transport, (marker) => {
      resolved.push(marker);
      return {hydrated: (marker as Record<string, unknown>)[HANDLE_MARKER]};
    });
    const received: WireMessage[] = [];
    codec.onMessage((m) => {
      received.push(m);
    });
    deliver({
      type: 'notification',
      method: '@S',
      params: [{[HANDLE_MARKER]: 's1'}, 42],
    });
    expect(resolved.length).toBe(1);
    expect(received[0]).toEqual({
      type: 'notification',
      method: '@S',
      params: [{hydrated: 's1'}, 42],
    });
  });

  it('raw mode: ignores malformed payloads', () => {
    const {transport, deliver} = makeRawTransport();
    const codec = new PeerCodec(transport);
    const received: WireMessage[] = [];
    codec.onMessage((m) => {
      received.push(m);
    });
    deliver(null);
    deliver('not-a-message');
    deliver({nope: 1});
    expect(received.length).toBe(0);
  });
});

describe('hydrateTree', () => {
  it('walks nested structures and resolves markers', () => {
    const out = hydrateTree(
      {
        a: [{[HANDLE_MARKER]: 's1'}, {x: {[HANDLE_MARKER]: 'o7'}}],
        b: 'literal',
      },
      (m) => `<${(m as Record<string, unknown>)[HANDLE_MARKER]}>`,
    );
    expect(out).toEqual({a: ['<s1>', {x: '<o7>'}], b: 'literal'});
  });

  it('passes primitives through', () => {
    expect(hydrateTree(42, () => 'x')).toBe(42);
    expect(hydrateTree('s', () => 'x')).toBe('s');
    expect(hydrateTree(null, () => 'x')).toBe(null);
  });
});

describe('substituteBrandsAndCollectTransferables', () => {
  function branded(id: string): unknown {
    const obj = {};
    Object.defineProperty(obj, BRAND_REMOTE, {
      value: {
        id,
        kind: id[0] as HandleKind,
        owner: 'server',
      } satisfies RemoteBrand,
      enumerable: false,
    });
    return obj;
  }

  it('substitutes branded values with @H markers', () => {
    const b = branded('o17');
    const out = substituteBrandsAndCollectTransferables({a: b, b: 1});
    expect(out).toEqual({a: {[HANDLE_MARKER]: 'o17'}, b: 1});
  });

  it('collects transferables into ctx.transfer', () => {
    const buf = new ArrayBuffer(8);
    const ctx: TransportContext = {};
    const out = substituteBrandsAndCollectTransferables({payload: buf}, ctx);
    expect((out as any).payload).toBe(buf);
    expect(ctx.transfer?.[0]).toBe(buf);
  });

  it('turns undefined array slots into null (matches serializer contract)', () => {
    const out = substituteBrandsAndCollectTransferables([1, undefined, 3]);
    expect(out).toEqual([1, null, 3]);
  });

  it('honors toJSON for Date and custom opt-outs', () => {
    const date = new Date('2020-01-01T00:00:00Z');
    const out = substituteBrandsAndCollectTransferables(date);
    expect(out).toBe(date.toJSON());
  });

  it('drops unbranded functions from objects, turns them to null in arrays', () => {
    const fn = () => 1;
    const out1 = substituteBrandsAndCollectTransferables({a: fn, b: 2});
    expect(out1).toEqual({b: 2});
    const out2 = substituteBrandsAndCollectTransferables([1, fn, 3]);
    expect(out2).toEqual([1, null, 3]);
  });

  it('does not walk into branded remote proxies', () => {
    const fake = branded('o5');
    (fake as any).nested = {deeply: {bad: true}}; // would break if walked
    const out = substituteBrandsAndCollectTransferables(fake);
    expect(out).toEqual({[HANDLE_MARKER]: 'o5'});
  });
});

describe('isTransferable', () => {
  it('recognizes ArrayBuffer', () => {
    expect(isTransferable(new ArrayBuffer(8))).toBe(true);
  });

  it('rejects plain objects and typed arrays', () => {
    // TypedArray views are NOT Transferable — only the underlying ArrayBuffer is.
    expect(isTransferable({})).toBe(false);
    expect(isTransferable(new Uint8Array(8))).toBe(false);
    expect(isTransferable('str')).toBe(false);
    expect(isTransferable(null)).toBe(false);
  });
});
