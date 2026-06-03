/**
 * Caller-side worker fixture that drives sync calls through the
 * production `enableSyncClient` wrapper (not raw Atomics like the
 * `_caller-fixture.ts` sibling). Used by
 * `enable-client-server.test.ts` to validate the full caller↔host
 * round trip end-to-end.
 *
 * Multiplexes two channels over `parentPort`:
 *
 *   `{kind: 'mixed-signals', data}` — sync-RPC base transport.
 *   `{kind: 'test', data}` — test-driver commands.
 */
import {parentPort} from 'node:worker_threads';
import type {
  RawTransport,
  TransportContext,
  WireMessage,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';

if (!parentPort) {
  throw new Error('_real-caller-fixture must run inside a Node Worker');
}

type TestCommand =
  | {
      type: 'wait-batch';
      id: number;
      calls: WireMessage[];
      timeoutMs?: number;
    }
  | {type: 'wait-batch-expect-throw'; id: number; calls: WireMessage[]; timeoutMs?: number};

type TestResult =
  | {type: 'ready'}
  | {type: 'fatal'; error: string}
  | {
      type: 'wait-batch-result';
      id: number;
      ok: true;
      results: WireMessage[];
    }
  | {
      type: 'wait-batch-throw-result';
      id: number;
      ok: true;
      errorName: string;
      errorMessage: string;
    }
  | {type: 'command-result'; id: number; ok: false; error: string};

const rpcListeners: Array<
  (data: unknown, ctx?: TransportContext) => void | Promise<void>
> = [];
const testListeners: Array<(data: unknown) => void> = [];

parentPort.on('message', (envelope: {kind: string; data: unknown}) => {
  if (envelope?.kind === 'mixed-signals') {
    for (const listener of rpcListeners) listener(envelope.data);
  } else if (envelope?.kind === 'test') {
    for (const listener of testListeners) listener(envelope.data);
  }
});

const base: RawTransport = {
  mode: 'raw',
  send(data, _ctx) {
    parentPort!.postMessage({kind: 'mixed-signals', data});
  },
  onMessage(cb) {
    rpcListeners.push(cb);
  },
};

function sendTest(result: TestResult): void {
  parentPort!.postMessage({kind: 'test', data: result});
}

(async () => {
  try {
    const transport = await enableSyncClient(base, {timeoutMs: 5000});

    // Subscribe so the wrapper drains any handshake-window buffered
    // messages. We don't actually process them — the fixture has no
    // RPCClient — but the drain is part of the contract under test.
    transport.onMessage(() => {});

    sendTest({type: 'ready'});

    testListeners.push((cmd) => {
      const c = cmd as TestCommand;
      if (c.type === 'wait-batch') {
        try {
          const results = transport.wait!(c.calls, {timeoutMs: c.timeoutMs});
          sendTest({
            type: 'wait-batch-result',
            id: c.id,
            ok: true,
            results,
          });
        } catch (err) {
          sendTest({
            type: 'command-result',
            id: c.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else if (c.type === 'wait-batch-expect-throw') {
        try {
          transport.wait!(c.calls, {timeoutMs: c.timeoutMs});
          sendTest({
            type: 'command-result',
            id: c.id,
            ok: false,
            error: 'expected wait to throw but it returned',
          });
        } catch (err) {
          sendTest({
            type: 'wait-batch-throw-result',
            id: c.id,
            ok: true,
            errorName: (err as Error).name,
            errorMessage: (err as Error).message,
          });
        }
      }
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();
