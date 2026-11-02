import { Toolbox } from '../../src/tools.mjs';
const root = process.argv[2];
const tb = new Toolbox({ workdir: root, cfg: { worker: { shellTimeoutMs: 3000 } } });
const escape = await tb.call('fs.write', { path: '../demo-guest/hacked.md', content: 'x' });
const absolute = await tb.call('fs.write', { path: 'G:\\Windows\\Temp\\hacked.md', content: 'x' });
const inside = await tb.call('fs.write', { path: 'ok.md', content: 'fine' });
console.log(JSON.stringify({ escape, absolute, inside, denied: tb.denied }, null, 1));
