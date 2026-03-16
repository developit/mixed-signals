import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {RPC} from '../../server/rpc.ts';
import {Counter, createTransportPair} from '../helpers.ts';

describe('RPC', () => {
  let rpc: RPC;

  beforeEach(() => {
    rpc = new RPC();
  });

  describe('expose', () => {
    it('registers root instance at id 0', () => {
      const root = new Counter();
      rpc.expose(root);
      assert.equal(rpc.instances.get('0'), root);
    });

    it('sends serialized root to client on addClient', () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const sent: string[] = [];
      const {server} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      assert.equal(sent.length, 1);
      assert.ok(sent[0].startsWith('N:@R:'));
      const payload = JSON.parse(sent[0].slice(5));
      assert.equal(payload['@M'], 'Counter#0');
    });
  });

  describe('addClient', () => {
    it('returns cleanup function', () => {
      const {server} = createTransportPair();
      const cleanup = rpc.addClient(server, 'c1');
      assert.equal(typeof cleanup, 'function');
    });

    it('cleanup stops message delivery', () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const sent: string[] = [];
      const {server} = createTransportPair();
      server.send = (data) => sent.push(data);

      const cleanup = rpc.addClient(server, 'c1');
      sent.length = 0; // clear initial @R message

      cleanup();
      rpc.notify('test', ['data']);
      assert.equal(sent.length, 0);
    });
  });

  describe('message handling', () => {
    it('method call on root returns result', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      // Intercept messages sent to client
      const origSend = server.send;
      server.send = (data) => {
        sent.push(data);
        origSend.call(server, data);
      };

      rpc.addClient(server, 'c1');
      sent.length = 0;

      // Simulate client sending method call
      client.send('M1:increment:');

      // Wait for async handling
      await new Promise((r) => setTimeout(r, 10));

      // Should have received a response
      const response = sent.find((s) => s.startsWith('R1:'));
      assert.ok(response, `Expected R1 response, got: ${sent.join(', ')}`);
    });

    it('instance method via id#method syntax', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const child = new Counter();
      rpc.instances.register('99', child);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      sent.length = 0;

      client.send('M2:99#increment:');
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(child.count.peek(), 1);
      assert.ok(sent.some((s) => s.startsWith('R2:')));
    });

    it('unknown instance returns error', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      sent.length = 0;

      client.send('M3:unknown#method:');
      await new Promise((r) => setTimeout(r, 10));

      const err = sent.find((s) => s.startsWith('E3:'));
      assert.ok(err, `Expected error, got: ${sent.join(', ')}`);
      assert.ok(err!.includes('Instance not found'));
    });

    it('non-function method returns error', async () => {
      const root = {notAMethod: 42};
      rpc.expose(root);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      sent.length = 0;

      client.send('M4:notAMethod:');
      await new Promise((r) => setTimeout(r, 10));

      const err = sent.find((s) => s.startsWith('E4:'));
      assert.ok(err, `Expected error, got: ${sent.join(', ')}`);
      assert.ok(err!.includes('Method not found'));
    });

    it('dot notation for nested property access', async () => {
      const root = {
        nested: {
          deep: {
            greet() {
              return 'hi';
            },
          },
        },
      };
      rpc.expose(root);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      sent.length = 0;

      client.send('M5:nested.deep.greet:');
      await new Promise((r) => setTimeout(r, 10));

      const response = sent.find((s) => s.startsWith('R5:'));
      assert.ok(response);
      assert.ok(response!.includes('"hi"'));
    });

    it('@W message calls reflection watch', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const {server, client} = createTransportPair();
      rpc.addClient(server, 'c1');

      // Send watch request
      client.send('N:@W:1,2,3');
      // Should not throw
    });

    it('@U message calls reflection unwatch', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const {server, client} = createTransportPair();
      rpc.addClient(server, 'c1');

      client.send('N:@U:1,2');
      // Should not throw
    });

    it('method with parameters', async () => {
      rpc.registerModel('Counter', Counter);
      const root = new Counter();
      rpc.expose(root);

      const sent: string[] = [];
      const {server, client} = createTransportPair();
      server.send = (data) => sent.push(data);

      rpc.addClient(server, 'c1');
      sent.length = 0;

      client.send('M6:rename:"new-name"');
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(root.name.peek(), 'new-name');
    });
  });

  describe('notify', () => {
    it('sends notification to specific client', () => {
      const sentA: string[] = [];
      const sentB: string[] = [];
      const {server: sA} = createTransportPair();
      const {server: sB} = createTransportPair();
      sA.send = (data) => sentA.push(data);
      sB.send = (data) => sentB.push(data);

      rpc.addClient(sA, 'a');
      rpc.addClient(sB, 'b');

      rpc.notify('hello', ['world'], 'a');
      assert.equal(sentA.length, 1);
      assert.ok(sentA[0].includes('hello'));
      assert.equal(sentB.length, 0);
    });

    it('broadcasts to all clients when no clientId', () => {
      const sentA: string[] = [];
      const sentB: string[] = [];
      const {server: sA} = createTransportPair();
      const {server: sB} = createTransportPair();
      sA.send = (data) => sentA.push(data);
      sB.send = (data) => sentB.push(data);

      rpc.addClient(sA, 'a');
      rpc.addClient(sB, 'b');

      rpc.notify('ping', [42]);
      assert.equal(sentA.length, 1);
      assert.equal(sentB.length, 1);
    });
  });

  describe('send', () => {
    it('formats result messages as R{id}:json', () => {
      const sent: string[] = [];
      const {server} = createTransportPair();
      server.send = (data) => sent.push(data);
      rpc.addClient(server, 'c1');

      rpc.send('c1', {id: 7, result: {foo: 'bar'}});
      assert.equal(sent[0], 'R7:{"foo":"bar"}');
    });

    it('formats error messages as E{id}:json', () => {
      const sent: string[] = [];
      const {server} = createTransportPair();
      server.send = (data) => sent.push(data);
      rpc.addClient(server, 'c1');

      rpc.send('c1', {id: 3, error: {code: -1, message: 'oops'}});
      assert.equal(sent[0], 'E3:{"code":-1,"message":"oops"}');
    });

    it('passes string messages through unchanged', () => {
      const sent: string[] = [];
      const {server} = createTransportPair();
      server.send = (data) => sent.push(data);
      rpc.addClient(server, 'c1');

      rpc.send('c1', 'raw-message');
      assert.equal(sent[0], 'raw-message');
    });

    it('no-op for unknown client', () => {
      // Should not throw
      rpc.send('nonexistent', {id: 1, result: null});
    });
  });
});
