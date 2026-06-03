/**
 * Worker-side fixture for `RPCClient.wait` end-to-end tests. Runs a
 * real `RPCClient` over an `enableSyncClient`-wrapped transport and
 * dispatches sync calls per command from the test driver.
 */
import {parentPort} from 'node:worker_threads';
import {RPCClient} from '../../client/rpc.ts';
import {typeOfRemote} from '../../shared/brand.ts';
import type {
  RawTransport,
  TransportContext,
} from '../../shared/protocol.ts';
import {enableSyncClient} from '../../sync/client.ts';

if (!parentPort) {
  throw new Error('_rpc-wait-fixture must run inside a Node Worker');
}

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

function sendTest(data: unknown): void {
  parentPort!.postMessage({kind: 'test', data});
}

(async () => {
  try {
    const transport = await enableSyncClient(base, {timeoutMs: 5000});
    const client = new RPCClient(transport);
    await client.ready;

    sendTest({type: 'ready'});

    testListeners.push((cmd: unknown) => {
      const c = cmd as {
        type: string;
        id: number;
        method?: string;
        args?: unknown[];
        calls?: Array<{method: string; args: unknown[]}>;
      };

      try {
        switch (c.type) {
          case 'sync-call': {
            const [value] = client.wait([
              client.root[c.method!](...(c.args ?? [])),
            ]);
            sendTest({type: 'sync-call-result', id: c.id, ok: true, value});
            return;
          }
          case 'sync-batch': {
            const promises = c.calls!.map((call) =>
              client.root[call.method](...call.args),
            );
            const values = client.wait(promises);
            sendTest({type: 'sync-batch-result', id: c.id, ok: true, values});
            return;
          }
          case 'sync-call-handle': {
            const [handle] = client.wait([client.root[c.method!]()]);
            sendTest({
              type: 'sync-call-handle-result',
              id: c.id,
              ok: true,
              typeName: typeOfRemote(handle),
              valueOfValue: (handle as {value: {peek(): unknown}}).value.peek(),
            });
            return;
          }
          case 'reuse-await-then-wait': {
            // First `await` the promise, then try to `rpc.wait` it.
            const p = client.root.ping();
            void p.then(() => {
              try {
                client.wait([p]);
                sendTest({
                  type: 'reuse-await-then-wait-result',
                  id: c.id,
                  ok: false,
                  error: 'expected wait to throw but it returned',
                });
              } catch (err) {
                sendTest({
                  type: 'reuse-await-then-wait-result',
                  id: c.id,
                  ok: true,
                  errorName: (err as Error).name,
                });
              }
            });
            return;
          }
          case 'wait-plain-promise': {
            try {
              client.wait([
                Promise.resolve('plain') as never,
              ]);
              sendTest({
                type: 'wait-plain-promise-result',
                id: c.id,
                ok: false,
                error: 'expected wait to throw but it returned',
              });
            } catch (err) {
              sendTest({
                type: 'wait-plain-promise-result',
                id: c.id,
                ok: true,
                errorName: (err as Error).name,
              });
            }
            return;
          }
          case 'sync-batch-expect-throw': {
            try {
              const promises = c.calls!.map((call) =>
                client.root[call.method](...call.args),
              );
              client.wait(promises);
              sendTest({
                type: 'sync-batch-expect-throw-result',
                id: c.id,
                ok: false,
                error: 'expected wait to throw but it returned',
              });
            } catch (err) {
              sendTest({
                type: 'sync-batch-expect-throw-result',
                id: c.id,
                ok: true,
                errorMessage: (err as Error).message,
              });
            }
            return;
          }
        }
      } catch (err) {
        sendTest({
          type: 'command-result',
          id: c.id,
          ok: false,
          error: (err as Error).message,
        });
      }
    });
  } catch (err) {
    sendTest({type: 'fatal', error: (err as Error).message});
  }
})();
