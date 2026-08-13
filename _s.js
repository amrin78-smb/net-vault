const { Client } = require('pg');
const go = async () => {
  const c = new Client({ host:'192.168.6.111', port:5432, user:'claude_readonly',
    password: process.env.DB_READONLY_PASS, database:'spanvault', ssl:false, connectionTimeoutMillis: 12000 });
  await c.connect();
  const q = async (l,s,p=[]) => { const r=await c.query(s,p); console.log(`\n=== ${l} ===`);
    r.rows.forEach(x=>console.log('  ',JSON.stringify(x))); if(!r.rows.length)console.log('   (none)'); return r.rows; };
  await q('sensors table columns',
    `SELECT column_name FROM information_schema.columns WHERE table_name='sensors' ORDER BY ordinal_position`);
  await q('bandwidth sensors: which metric_name convention per device',
    `SELECT d.name, s.metric_name, s.std_metric, COUNT(*)::int n
     FROM sensors s JOIN monitored_devices d ON d.id=s.device_id
     WHERE s.metric_name LIKE '%bps%' OR s.std_metric LIKE '%bps%'
     GROUP BY 1,2,3 ORDER BY d.name, s.metric_name LIMIT 20`);
  await q('does snmp_results carry if_index for the indexed rows? (per-interface split available)',
    `SELECT metric_name, if_index, if_name, COUNT(*)::int n
     FROM snmp_results WHERE device_id=4 AND ts > NOW() - interval '2 hours'
       AND metric_name ~ 'bps' GROUP BY 1,2,3 ORDER BY 1 LIMIT 10`);
  await c.end();
};
(async()=>{ for(let i=1;i<=2;i++){ try{ return await go(); }catch(e){ console.log(`attempt ${i}: ${e.message}`); await new Promise(r=>setTimeout(r,4000)); } } })();
