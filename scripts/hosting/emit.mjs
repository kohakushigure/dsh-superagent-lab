/** emit.mjs - 投递一条事件到常驻 loop（带 x-auth-token），打印原始响应。 */
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) { const k = cur.slice(2); const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; acc.push([k, v]); }
  return acc;
}, []));
const port = Number(args.port || 3082);
const token = args.token || process.env.SUPERAGENT_AUTH_TOKEN || '';
const body = {
  text: args.text || '',
  thread: args.thread || undefined,
  source: args.source || 'http',
  author: args.author || 'emit'
};
const res = await fetch('http://127.0.0.1:' + port + '/api/triggers', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, token ? { 'x-auth-token': token } : {}),
  body: JSON.stringify(body)
});
console.log(res.status + ' ' + (await res.text()));
