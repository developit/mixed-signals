import {execSync} from 'node:child_process';
import os from 'node:os';

export function getEnvMetadata(profile: string) {
  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse --short HEAD', {encoding: 'utf8'}).trim();
  } catch {
    // noop
  }

  return {
    timestamp: new Date().toISOString(),
    gitSha,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    profile,
  };
}
