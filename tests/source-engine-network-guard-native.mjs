// Run the actual Rust module with a fake Tauri IPC boundary, without Cargo/target writes.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

const testDir = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(testDir, '..');
const nativeRoot = join(pcRoot, 'src-tauri');
const tmpPath = resolve(pcRoot, '_tmp');
mkdirSync(tmpPath, { recursive: true });
const tmpRoot = realpathSync(tmpPath);
const output = mkdtempSync(join(tmpRoot, 'ipc-guard-regression-'));
let exitCode;
try {
  const labels = [
    ['source_window.rs', 'SOURCE_ENGINE_LABEL', 'source-window-label.rs'],
    ['lyric_window.rs', 'LYRIC_WINDOW_LABEL', 'lyric-window-label.rs'],
  ];
  const env = { ...process.env };
  for (const [source, name, target] of labels) {
    const text = readFileSync(join(nativeRoot, 'src', source), 'utf8');
    const declaration = text.match(new RegExp(`^pub const ${name}: &str = "[^"\\r\\n]+";$`, 'm'))?.[0];
    if (!declaration) throw new Error(`Missing production public window label ${name}`);
    const labelFile = join(output, target);
    writeFileSync(labelFile, `${declaration}\n`);
    env[name === 'SOURCE_ENGINE_LABEL' ? 'SOURCE_WINDOW_LABEL_FILE' : 'LYRIC_WINDOW_LABEL_FILE'] = labelFile;
  }
  const target = process.env.CARGO_TARGET_DIR || join(nativeRoot, 'target', 'native-check');
  const deps = join(target, 'debug', 'deps');
  const logging = readdirSync(deps)
    .filter(name => /^liblog-.*\.rlib$/.test(name))
    .map(name => join(deps, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!logging) throw new Error('No existing native log rlib; build native crate dependencies first');
  const executable = join(output, process.platform === 'win32' ? 'ipc-guard-tests.exe' : 'ipc-guard-tests');
  const compilation = spawnSync('rustc', [
    '--edition=2021', '--test', join(testDir, 'source-engine-network-guard-native.rs'),
    '--extern', `log=${logging}`, '-L', `dependency=${deps}`, '-o', executable,
  ], { env, stdio: 'inherit' });
  if (compilation.error) throw compilation.error;
  if (compilation.status !== 0) {
    console.error('Harness compilation failed: this is not a behavior red.');
    exitCode = compilation.status ?? 1;
  } else {
    const test = spawnSync(executable, process.argv.slice(2), { env, stdio: 'inherit' });
    if (test.error) throw test.error;
    exitCode = test.status ?? 1;
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
}
try {
  // Delete only the unique directory just created beneath the known _tmp root.
  const child = relative(tmpRoot, resolve(output));
  if (!child.startsWith('ipc-guard-regression-') || child.includes('..')
    || dirname(realpathSync(output)) !== tmpRoot || lstatSync(output).isSymbolicLink()
    || resolve(tmpRoot, child) !== realpathSync(output)) {
    throw new Error('Refusing unexpected harness cleanup path');
  }
  rmSync(output, { recursive: true, force: true });
} catch (error) {
  console.error(error);
  // Cleanup failure must fail a successful run without hiding an earlier
  // compiler/test failure code. Never throw from a finally block.
  exitCode ||= 1;
}
process.exitCode = exitCode;
