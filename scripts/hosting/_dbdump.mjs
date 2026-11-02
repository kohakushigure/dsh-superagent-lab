import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const all = (s) => db.prepare(s).all();
console.log('tables:', all("select name from sqlite_master where type='table'").map(r=>r.name).join(','));
for (const t of ['tasks','triggers','decisions','subscriptions']) {
  try { console.log(t+':', JSON.stringify(all('select * from '+t).slice(0,4), null, 1).slice(0,900)); } catch (e) { console.log(t+' ERR', e.message); }
}
