import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Independent acceptance probes. Each child runs against the CLEAN COPY and prints
 * PROBE_RESULT lines that this runner aggregates. Exit code is non-zero if any case failed.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || '');
const outDir = process.argv[3] || path.join(dir, '..');
if (!fs.existsSync(path.join(dir, 'bin', 'superagent.mjs'))) {
  console.error('not a clean copy: ' + dir);
  process.exit(2);
}

const ALL_CASES = [
  ['A', 'p1-passthrough.mjs'],
  ['B', 'p2-recovery.mjs'],
  ['C', 'p3-watchdog.mjs'],
  ['D', 'p4-spill.mjs'],
  ['E', 'p5-panel.mjs'],
  ['F', 'p6-mock.mjs'],
  ['G', 'p7-unsubscribe.mjs'],   // added by the T5 regression round (M1: unsubscribe stops passthrough)
  ['O', 'p8-bookkeeping.mjs'],   // informational: worker.active bookkeeping observations (see docs/05 §12)
  // T7 hosted-mode group (docs/05 §13)
  ['H1', 'h1-ingest.mjs'],        // POST /api/triggers feeds the resident loop
  ['H2', 'h2-concurrency.mjs'],   // MAX_CONCURRENCY gates dispatch (sampled in flight)
  ['H3', 'h3-isolation.mjs'],     // PROJECTS isolation + path-escape denial
  ['H4', 'h4-resident.mjs'],      // hosted start/kill/recover/-Stop via start-hosted.ps1
  ['H5', 'h5-autostart.ps1']      // three-tier autostart install/status/remove with zero residue
];

/** --only=A,C  restricts the run to the named cases (regression rounds). Default: all. */
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
const CASES = only ? ALL_CASES.filter((c) => only.includes(c[0])) : ALL_CASES;
if (only && !CASES.length) {
  console.error('--only matched no case; known: ' + ALL_CASES.map((c) => c[0]).join(','));
  process.exit(2);
}

function run(file) {
  return new Promise((resolve) => {
    const full = path.join(HERE, file);
    // .ps1 probes run under Windows PowerShell; everything else under node
    const isPs = /\.ps1$/i.test(file);
    const cmd = isPs ? 'powershell.exe' : process.execPath;
    const argv = isPs ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full, '-CleanDir', dir] : [full, dir];
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d.toString(); process.stderr.write(d); });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

const results = [];
for (const [id, file] of CASES) {
  process.stdout.write('\n===== CASE ' + id + ' :: ' + file + ' =====\n');
  const r = await run(file);
  const line = r.out.split(/\r?\n/).reverse().find((l) => l.startsWith('PROBE_RESULT '));
  let rec = null;
  if (line) { try { rec = JSON.parse(line.slice(13)); } catch { rec = null; } }
  results.push(rec
    ? { case: rec.case, label: rec.label, checks: rec.checks, passed: rec.passed, failed: rec.failed, exitCode: r.code, detail: rec.detail }
    : { case: id, label: file, checks: 1, passed: 0, failed: 1, exitCode: r.code, error: 'no PROBE_RESULT line', detail: [{ name: 'probe produced no result', ok: false, detail: { tail: r.out.slice(-800) } }] });
}

const totals = results.reduce((a, r) => ({ checks: a.checks + r.checks, passed: a.passed + r.passed, failed: a.failed + r.failed }), { checks: 0, passed: 0, failed: 0 });
const failedCases = results.filter((r) => r.failed > 0 || r.exitCode !== 0).map((r) => r.case);
const summary = { generatedAt: new Date().toISOString(), cleanCopy: dir, cases: results, totals, failedCases };

const outFile = path.join(outDir, 'probes-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
process.stdout.write('\n===== PROBE SUMMARY =====\n');
for (const r of results) process.stdout.write('  case ' + r.case + '  ' + String(r.passed).padStart(3) + '/' + String(r.checks).padEnd(3) + ' passed  failed=' + r.failed + '  ' + r.label + '\n');
process.stdout.write('  TOTAL ' + totals.passed + '/' + totals.checks + ' checks passed, ' + totals.failed + ' failed; failed cases: ' + (failedCases.join(',') || 'none') + '\n');
process.stdout.write('  written: ' + outFile + '\n');
process.exit(totals.failed === 0 && failedCases.length === 0 ? 0 : 1);
