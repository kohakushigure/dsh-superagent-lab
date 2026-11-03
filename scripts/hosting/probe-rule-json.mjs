import fs from 'node:fs';
const s = fs.readFileSync('G:\\Agent-workspace\\dsh-superagent\\scripts\\hosting\\loop-patent.ps1', 'utf8');
const start = s.indexOf('@' + String.fromCharCode(39)) + 2;
const end = s.indexOf(String.fromCharCode(39) + '@', start);
const raw = s.slice(start, end).trim();
try {
  const o = JSON.parse(raw);
  const k = Object.keys(o)[0];
  console.log('json ok, key=', k);
  console.log('prBranch=', o[k].prBranch, 'runCwd=', o[k].runCwd);
  console.log('recipe steps=', o[k].recipe.length);
  console.log('run includes tests=', o[k].run.some((c) => c.includes('test_ota_acceptance')));
} catch (e) { console.log('JSON ERROR:', e.message.slice(0, 160)); }
