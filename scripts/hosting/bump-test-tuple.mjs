import fs from 'node:fs';
const p = 'G:/Agent-workspace/dsh-superagent/dist/live/patent/patent-tool/backend/tests/unit/test_ota_core.py';
let s = fs.readFileSync(p, 'utf8');
const n = (s.match(/\(1, 0, 0, 27\)/g) || []).length;
s = s.split('(1, 0, 0, 27)').join('(1, 0, 0, 29)');
fs.writeFileSync(p, s);
console.log('tuple literals replaced:', n);
