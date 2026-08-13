const { Client } = require('pg');
const go = async () => {
  const c = new Client({ host:'192.168.6.111', port:5432, user:'claude_readonly',
    password: process.env.DB_READONLY_PASS, database:'ddivault', ssl:false, connectionTimeoutMillis: 12000 });
  await c.connect();
  const q = async (l,s) => { const r=await c.query(s); console.log(`\n=== ${l} ===`);
    r.rows.forEach(x=>console.log('  ',JSON.stringify(x))); if(!r.rows.length)console.log('   (none)'); };

  await q('the 70 OPEN alerts — what kind, by rule',
    `SELECT COALESCE(ar.name,'(no rule)') AS rule, COALESCE(ar.alert_type,'-') AS type,
            ae.severity, COUNT(*)::int n, MIN(ae.fired_at)::date AS oldest, MAX(ae.fired_at)::date AS newest
     FROM alert_events ae LEFT JOIN alert_rules ar ON ar.id = ae.rule_id
     WHERE ae.acknowledged = FALSE AND ae.resolved_at IS NULL
     GROUP BY 1,2,3 ORDER BY n DESC`);

  await q('severity mix across ALL alerts ever',
    `SELECT severity, COUNT(*)::int n FROM alert_events GROUP BY 1 ORDER BY n DESC`);

  await q('what fires most (last 30d, by rule) — the noise ranking',
    `SELECT COALESCE(ar.name,'(no rule)') AS rule, ae.severity, COUNT(*)::int fired_30d
     FROM alert_events ae LEFT JOIN alert_rules ar ON ar.id = ae.rule_id
     WHERE ae.fired_at > NOW() - interval '30 days'
     GROUP BY 1,2 ORDER BY fired_30d DESC LIMIT 10`);
  await c.end();
};
(async()=>{ for(let i=1;i<=3;i++){ try{ return await go(); }catch(e){ console.log(`attempt ${i}: ${e.message}`); await new Promise(r=>setTimeout(r,4000)); } } })();
