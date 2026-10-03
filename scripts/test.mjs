import { readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = fileURLToPath(new URL('../tsconfig.test.emit.json', import.meta.url));
const output = fileURLToPath(new URL('../.test-build', import.meta.url));
const testDirectory = fileURLToPath(new URL('../.test-build/tests', import.meta.url));
process.chdir(root);
const testArgs = () => ['--test', ...readdirSync('.test-build/tests').filter(name => name.endsWith('.test.js')).map(name => resolve(testDirectory, name))];
const diagnosticHost = {
  getCanonicalFileName: name => name,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
};
const report = diagnostics => console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));

function compile(program) {
  if (resolve(program.getCompilerOptions().outDir ?? '') !== output) throw new Error('Unexpected test output directory');
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) report(diagnostics);
  if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) return false;
  // Rebuild the small suite completely so deleted tests cannot survive in the emitted tree.
  rmSync(output, { recursive: true, force: true });
  const emitted = program.emit();
  if (emitted.diagnostics.length) report(emitted.diagnostics);
  return !emitted.emitSkipped && !emitted.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error);
}

if (!process.argv.includes('--watch')) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    report([config.error]);
    process.exitCode = 1;
  } else {
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    if (parsed.errors.length) {
      report(parsed.errors);
      process.exitCode = 1;
    } else if (compile(ts.createProgram(parsed.fileNames, parsed.options))) {
      const result = spawnSync(process.execPath, testArgs(), { cwd: root, stdio: 'inherit' });
      if (result.error) console.error(result.error);
      process.exitCode = result.status ?? 1;
    } else process.exitCode = 1;
  }
} else {
  // Trust the inherited Windows installation location, without executable lookup through PATH.
  const systemRoot = process.env.SystemRoot;
  if (process.platform === 'win32' && (!systemRoot || !isAbsolute(systemRoot))) throw new Error('Invalid Windows SystemRoot');
  const taskkill = process.platform === 'win32' ? resolve(systemRoot, 'System32', 'taskkill.exe') : undefined;
  let pending;
  let child;
  let stopping = false;
  let watch;
  const stop = code => {
    stopping = true;
    pending = undefined;
    watch?.close();
    process.exitCode = code;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (result.status !== 0) {
          try { process.kill(child.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return; throw error; }
          console.error('Could not terminate the owned test process tree');
          process.exitCode = 1;
        }
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  };
  const runPending = () => {
    if (stopping || child || !pending) return;
    const program = pending;
    pending = undefined;
    if (!compile(program)) return;
    child = spawn(process.execPath, testArgs(), { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
    child.once('error', error => { console.error(error); stop(1); });
    child.once('exit', () => { child = undefined; runPending(); });
  };
  const host = ts.createWatchCompilerHost(configPath, undefined, ts.sys, ts.createSemanticDiagnosticsBuilderProgram,
    diagnostic => report([diagnostic]), diagnostic => console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')));
  host.afterProgramCreate = builder => { pending = builder.getProgram(); runPending(); };
  watch = ts.createWatchProgram(host);
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
}
