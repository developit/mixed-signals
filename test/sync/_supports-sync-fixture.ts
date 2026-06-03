/**
 * Worker-side fixture for `support.node.ts` tests. Imports the
 * Node-conditional `supportsSync` from inside a `worker_threads`
 * Worker and reports its return value back to the parent.
 */
import {parentPort} from 'node:worker_threads';
import {supportsSync} from '../../sync/support.node.ts';

if (!parentPort) {
  throw new Error('_supports-sync-fixture must run inside a Node Worker');
}

parentPort.postMessage({type: 'result', value: supportsSync()});
