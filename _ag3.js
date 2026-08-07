const { Client } = require('pg');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 8; i++) {
    const c = new Client({ host:'192.168.6.111', port:5432, user:'claude_readonly',
      password: process.env.DB_READONLY_PASS, database:'netvault', ssl:false });
    await c.connect();
    const { rows } = await c.query(
      `SELECT name, agent_version, status,
              ROUND(EXTRACT(EPOCH FROM (NOW() - last_seen_at))) AS secs_ago
       FROM agents ORDER BY id`);
    await c.end();
    const r = rows[0];
    console.log(new Date().toTimeString().slice(0,8), JSON.stringify(r));
    if (r.agent_version === '2.6.4' && r.status === 'online' && Number(r.secs_ago) < 120) {
      console.log('=== agent fully back on 2.6.4 ==='); return;
    }
    await sleep(30000);
  }
  console.log('=== did not confirm 2.6.4 heartbeat in window ===');
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
