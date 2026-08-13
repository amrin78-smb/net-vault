const { Client } = require('pg');
const go = async () => {
  const c = new Client({ host:'192.168.6.111', port:5432, user:'claude_readonly',
    password: process.env.DB_READONLY_PASS, database:'spanvault', ssl:false, connectionTimeoutMillis: 12000 });
  await c.connect();
  const q = async (l,s) => { const r=await c.query(s); console.log(`\n=== ${l} ===`);
    r.rows.forEach(x=>console.log('  ',JSON.stringify(x))); if(!r.rows.length)console.log('   (none)'); };

  await q('device_baselines — what exists (this feeds anomalies AND thresholds)',
    `SELECT metric, COUNT(*)::int rows, COUNT(*) FILTER (WHERE sample_count>=50)::int usable,
            MIN(sample_count)::int min_samples, MAX(sample_count)::int max_samples,
            MAX(computed_at)::text newest
     FROM device_baselines GROUP BY 1 ORDER BY rows DESC`);

  await q('devices missing a ping threshold (NaN risk in the recommender)',
    `SELECT COUNT(*) FILTER (WHERE ping_threshold_ms IS NULL)::int null_threshold,
            COUNT(*) FILTER (WHERE ping_threshold_ms IS NOT NULL)::int has_threshold,
            COUNT(*)::int total FROM monitored_devices WHERE active`);

  await q('threshold_recommendations actually stored',
    `SELECT tr.device_id, d.name, tr.current_threshold, tr.recommended_threshold,
            ROUND(tr.confidence::numeric,2) confidence, tr.computed_at::date
     FROM threshold_recommendations tr LEFT JOIN monitored_devices d ON d.id=tr.device_id`);

  await q('anomaly_events — are they being produced and of what type',
    `SELECT anomaly_type, status, COUNT(*)::int n, MAX(detected_at)::text newest
     FROM anomaly_events WHERE detected_at > NOW() - interval '7 days'
     GROUP BY 1,2 ORDER BY n DESC LIMIT 10`);
  await c.end();
};
(async()=>{ for(let i=1;i<=2;i++){ try{ return await go(); }catch(e){ console.log(`attempt ${i}: ${e.message}`); await new Promise(r=>setTimeout(r,4000)); } } })();
