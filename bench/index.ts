import fs from 'node:fs/promises';
import {parseCli} from './cli.ts';
import {compareReports} from './reporters/compare.ts';
import {printConsoleReport} from './reporters/console.ts';
import {writeJsonReport} from './reporters/json.ts';
import {runHarness} from './runtime/harness.ts';
import {forwardingMiddleOverheadScenario} from './scenarios/forwarding-middle-overhead.ts';
import {initialLargeGraphScenario} from './scenarios/initial-large-graph.ts';
import {memoryLifecycleScenario} from './scenarios/memory.ts';
import {methodReflectedNested, methodReflectedRoot} from './scenarios/method-reflected.ts';
import {signalUpdatesScenario} from './scenarios/signal-updates.ts';

const scenarios = [
  methodReflectedRoot,
  methodReflectedNested,
  initialLargeGraphScenario,
  signalUpdatesScenario,
  forwardingMiddleOverheadScenario,
  memoryLifecycleScenario,
];

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (process.argv[1]?.includes('compare') || opts.compare) {
    const base = opts.compare?.base ?? 'bench/baselines/local.json';
    const head = opts.compare?.head ?? 'bench/results/latest.json';
    const out = await compareReports(base, head);
    if (out.notes.length > 0) {
      for (const note of out.notes) console.log(note);
    }
    process.exitCode = out.pass ? 0 : 1;
    return;
  }

  const run = await runHarness(opts, scenarios);
  printConsoleReport(run);
  const out = await writeJsonReport(run, opts.output);
  console.log(`\nWrote ${out}`);

  if (opts.baselineUpdate) {
    await fs.mkdir('bench/baselines', {recursive: true});
    await fs.writeFile('bench/baselines/local.json', JSON.stringify(run, null, 2));
    console.log('Updated bench/baselines/local.json');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
