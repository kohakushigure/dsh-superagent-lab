import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const t = db.prepare('select id,status,error,summary,report from tasks order by created_at desc limit 1').get();
console.log(JSON.stringify({ id: t.id, status: t.status, error: t.error, report: String(t.report||'').slice(0,300) }, null, 1));
const ev = db.prepare('select kind, detail from events where task_id = ? order by id desc limit 10').all(t.id);
for (const e of ev.reverse()) console.log(e.kind + ' :: ' + String(e.detail).slice(0, 220));
