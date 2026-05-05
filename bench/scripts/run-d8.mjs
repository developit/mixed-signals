import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PINNED_V8_VERSION = '12.4.254';

function detectBinary(kind) {
  const home = os.homedir();
  const name = process.platform === 'win32' ? `${kind}.cmd` : kind;
  return path.join(home, '.jsvu', 'bin', name);
}

function installFromArchive(engine, osFlag) {
  if (process.platform === 'win32') {
    return false;
  }

  const flavor = engine === 'v8-debug' ? 'dbg' : 'rel';
  const archiveName = `v8-${osFlag}-${flavor}-${PINNED_V8_VERSION}.zip`;
  const url = `https://storage.googleapis.com/chromium-v8/official/canary/${archiveName}`;
  const home = os.homedir();
  const root = path.join(home, '.jsvu');
  const tmpDir = path.join(root, 'tmp');
  const installDir = path.join(root, 'engines', `${engine}-${PINNED_V8_VERSION}`);
  const binDir = path.join(root, 'bin');
  const archivePath = path.join(tmpDir, archiveName);
  const shellPath = path.join(installDir, 'd8');
  const binaryPath = detectBinary(engine);

  fs.mkdirSync(tmpDir, {recursive: true});
  fs.mkdirSync(installDir, {recursive: true});
  fs.mkdirSync(binDir, {recursive: true});

  const download = spawnSync('curl', [
    '-fsSL',
    '--retry',
    '3',
    '--retry-delay',
    '1',
    '-o',
    archivePath,
    url,
  ]);
  if (download.status !== 0) return false;

  const unzip = spawnSync('unzip', ['-qo', archivePath, '-d', installDir]);
  if (unzip.status !== 0) return false;

  if (!fs.existsSync(shellPath)) return false;

  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env bash\nexec \"${shellPath}\" \"$@\"\n`,
    {mode: 0o755},
  );
  return fs.existsSync(binaryPath);
}

function ensureD8(useDebug) {
  const wanted = useDebug ? ['v8-debug'] : ['v8'];
  if (wanted.every((name) => fs.existsSync(detectBinary(name)))) return;

  const osFlag =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'mac64arm'
        : 'mac64'
      : process.platform === 'win32'
        ? process.arch === 'x64'
          ? 'win64'
          : 'win32'
        : process.arch === 'x64'
          ? 'linux64'
          : 'linux32';

  for (const engine of wanted) {
    const install = spawnSync(
      'pnpm',
      ['dlx', 'jsvu', `${engine}@${PINNED_V8_VERSION}`, `--os=${osFlag}`],
      {stdio: 'inherit'},
    );

    if (install.status === 0 && fs.existsSync(detectBinary(engine))) continue;

    const fallbackOk = installFromArchive(engine, osFlag);
    if (!fallbackOk) {
      console.error(`Failed to install ${engine} (jsvu + archive fallback failed).`);
      process.exit(1);
    }
  }

  if (!wanted.every((name) => fs.existsSync(detectBinary(name)))) {
    console.error(
      'Install completed but v8 binaries were not found on disk.',
    );
    process.exit(1);
  }
}

function run() {
  const useDebug = process.argv.includes('--debug');
  const profile =
    process.argv
      .filter((arg) => arg.startsWith('--profile='))
      .at(-1)
      ?.slice('--profile='.length) ?? 'full';
  const outFile =
    process.argv
      .find((arg) => arg.startsWith('--output='))
      ?.slice('--output='.length) ?? '';
  ensureD8(useDebug);

  const build = spawnSync('node', ['bench/scripts/build-d8-bundle.mjs'], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const bundlePath = build.stdout.trim().split('\n').pop();
  const runnerPath = path.resolve('bench/.tmp/d8-runner.js');
  fs.mkdirSync(path.dirname(runnerPath), {recursive: true});
  fs.writeFileSync(
    runnerPath,
    `globalThis.__BENCH_PROFILE = ${JSON.stringify(profile)};\nload(${JSON.stringify(bundlePath)});\n`,
  );
  const binary = detectBinary(useDebug ? 'v8-debug' : 'v8');

  const args = [runnerPath];

  const exec = spawnSync(binary, args, {encoding: 'utf8'});
  if (exec.stdout) process.stdout.write(exec.stdout);
  if (exec.stderr) process.stderr.write(exec.stderr);

  if (outFile && exec.stdout) {
    const lines = exec.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const jsonLine = lines.at(-1) ?? '';
    try {
      JSON.parse(jsonLine);
    } catch {
      console.error('d8 output did not end with valid JSON payload.');
      process.exit(1);
    }
    fs.writeFileSync(outFile, `${jsonLine}\n`);
  }

  process.exit(exec.status ?? 1);
}

run();
