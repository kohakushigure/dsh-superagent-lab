import { postIssueComment, formatReport } from '../../local-superagent/src/channel.mjs';
const body = formatReport({ id: 'task_channel_probe', deliverable: '(none)' }, {
  summary: 'Channel 层联通性验证：这条评论由 local-superagent 的 channel.mjs 直接调用 gh 发出。',
  ran: ['gh issue comment（本仓库 #1）'],
  notRun: ['合并、发版（按设计不在白名单里）']
});
const res = await postIssueComment({ repo: 'kohakushigure/dsh-superagent-lab', number: '1', body });
console.log(JSON.stringify(res, null, 1));
