import {PROFILES} from '../config.ts';
import type {
  BenchmarkCliOptions,
  BenchmarkRunResult,
  ScenarioCase,
  ScenarioResult,
} from '../types.ts';
import {getEnvMetadata} from './env.ts';

export async function runHarness(
  opts: BenchmarkCliOptions,
  scenarios: ScenarioCase[],
): Promise<BenchmarkRunResult> {
  const profile = PROFILES[opts.profile];
  const filtered = scenarios.filter((scenario) => {
    if (opts.scenario && !opts.scenario.includes(scenario.name)) return false;
    if (!scenario.mode.includes(opts.mode)) return false;
    if (opts.topology && !scenario.topology.includes(opts.topology)) return false;
    return true;
  });

  const results: ScenarioResult[] = [];
  for (const scenario of filtered) {
    const topology = opts.topology ?? scenario.topology[0];
    const transport = opts.mode === 'workers' ? 'messageport' : 'microtask';
    const metrics = await scenario.run({
      mode: opts.mode,
      topology,
      transport,
      profile,
      allowUnstable: Boolean(opts.allowUnstable),
    });

    results.push({
      scenario: scenario.name,
      mode: opts.mode,
      topology,
      transport,
      params: scenario.params,
      metrics,
    });
  }

  return {
    metadata: getEnvMetadata(opts.profile),
    results,
  };
}
