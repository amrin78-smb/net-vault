const { Client } = require('pg');
const go = async () => {
  const c = new Client({ host:'192.168.6.111', port:5432, user:'claude_readonly',
    password: process.env.DB_READONLY_PASS, database:'ddivault', ssl:false, connectionTimeoutMillis: 12000 });
  await c.connect();
  // Replay the last 7 days of real health samples through OLD vs NEW logic.
  const r = await c.query(`
    SELECT s.hostname, h.health_score AS score, h.created_at
    FROM server_health_history h JOIN ddi_servers s ON s.id = h.server_id
    WHERE h.created_at > NOW() - interval '7 days'
    ORDER BY s.hostname, h.created_at`);
  await c.end();
  const byHost = {};
  for (const x of r.rows) (byHost[x.hostname] ||= []).push(x);

  const COOLDOWN_MS = 60*60*1000, RECOVER = 85;
  let oldTotal = 0, newTotal = 0;
  console.log(`replayed ${r.rows.length} real health samples\n`);
  console.log('host                        samples   OLD fires   NEW fires');
  for (const [host, rows] of Object.entries(byHost)) {
    // OLD: fire when <80 and no open alert; resolve (closing it) as soon as >=80.
    let open=false, oldFires=0;
    for (const s of rows) {
      if (s.score < 80) { if (!open) { oldFires++; open = true; } }
      else if (open) open = false;               // resolved -> next dip re-fires
    }
    // NEW: same fire rule, but resolve only at >=85, plus a 60-min re-fire cooldown.
    let open2=false, newFires=0, lastResolved=null;
    for (const s of rows) {
      const t = new Date(s.created_at).getTime();
      if (s.score < 80) {
        const cooling = lastResolved != null && (t - lastResolved) < COOLDOWN_MS;
        if (!open2 && !cooling) { newFires++; open2 = true; }
      } else if (s.score >= RECOVER && open2) { open2 = false; lastResolved = t; }
      // 80..84 -> dead band, state unchanged
    }
    oldTotal += oldFires; newTotal += newFires;
    console.log(`${host.padEnd(28)}${String(rows.length).padStart(7)}${String(oldFires).padStart(12)}${String(newFires).padStart(12)}`);
  }
  console.log(`${''.padEnd(28)}${''.padStart(7)}${String(oldTotal).padStart(12)}${String(newTotal).padStart(12)}`);
  const cut = oldTotal ? Math.round((1 - newTotal/oldTotal)*100) : 0;
  console.log(`\n  health-score alerts over 7 days: ${oldTotal} -> ${newTotal}  (${cut}% fewer)`);
};
(async()=>{ for(let i=1;i<=2;i++){ try{ return await go(); }catch(e){ console.log(`attempt ${i}: ${e.message}`); await new Promise(r=>setTimeout(r,3000)); } } })();
