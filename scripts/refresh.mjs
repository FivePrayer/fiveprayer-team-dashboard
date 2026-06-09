// Regenerates data.json from live sources. Run by .github/workflows/refresh-data.yml on a schedule.
// Requires secret SUPABASE_DB_URL (read-only Postgres connection string from Supabase → Settings → Database).
// Optional secret GH_PAT (fine-grained PAT with read access to the 4 repos) to also refresh the commit heatmap.
import pg from 'pg';
import { readFileSync, writeFileSync } from 'fs';

const prev = JSON.parse(readFileSync('data.json', 'utf8')); // preserve sections we can't refresh
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (sql) => (await db.query(sql)).rows;

// ---- product metrics (live) ----
const totals = (await q(`SELECT
  (SELECT count(*) FROM users) app_opens,
  (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'provider' IS NOT NULL) accounts,
  (SELECT count(DISTINCT user_id) FROM prayer_logs) prayed,
  (SELECT count(*) FROM prayer_logs WHERE created_at >= now()-interval '24 hours') checkins24,
  (SELECT count(DISTINCT user_id) FROM prayer_logs WHERE created_at >= now()-interval '30 days') mau30,
  (SELECT count(*) FROM subscriptions WHERE status::text <> 'free') paying`))[0];

const byType = await q(`WITH u AS (SELECT id, coalesce(raw_app_meta_data->>'provider','anonymous') k FROM auth.users),
  a AS (SELECT DISTINCT user_id FROM prayer_logs)
  SELECT u.k kind, count(*) n, round(100.0*count(x.user_id)/nullif(count(*),0),1) pct
  FROM u LEFT JOIN a x ON x.user_id=u.id GROUP BY 1`);
const tmap = Object.fromEntries(byType.map(r => [r.kind, r]));

const dau = await q(`SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') d, count(DISTINCT user_id) dau, count(*) c
  FROM prayer_logs WHERE created_at >= now()-interval '90 days' AND created_at < date_trunc('day',now())
  GROUP BY 1 ORDER BY 1`);
const signups = await q(`SELECT to_char(date_trunc('day',u.created_at),'YYYY-MM-DD') d,
  count(*) FILTER (WHERE au.raw_app_meta_data->>'provider' IS NULL) anon,
  count(*) FILTER (WHERE au.raw_app_meta_data->>'provider'='google') g,
  count(*) FILTER (WHERE au.raw_app_meta_data->>'provider'='apple') a
  FROM users u JOIN auth.users au ON au.id=u.id
  WHERE u.created_at >= now()-interval '140 days' AND u.created_at < date_trunc('day',now())
  GROUP BY 1 ORDER BY 1`);
const outcomes = await q(`SELECT status::text s, count(*) n FROM prayer_logs WHERE created_at >= now()-interval '30 days' GROUP BY 1 ORDER BY 2 DESC`);
const cohort = await q(`WITH a AS (SELECT DISTINCT user_id FROM prayer_logs)
  SELECT to_char(date_trunc('month',u.created_at),'Mon') m, date_trunc('month',u.created_at) mm,
  round(100.0*count(x.user_id)/nullif(count(*),0),1) pct
  FROM users u LEFT JOIN a x ON x.user_id=u.id WHERE u.created_at >= '2026-02-01' GROUP BY 1,2 ORDER BY 2`);

await db.end();

const OUTLABEL = { on_time: 'On time', late: 'Late', missed: 'Missed', menstruation: 'Menstruation' };
const data = {
  ...prev,
  generatedAt: new Date().toISOString(),
  kpis: {
    appOpens: +totals.app_opens, accounts: +totals.accounts, activationPct: +(100 * totals.prayed / totals.app_opens).toFixed(1),
    mau30: +totals.mau30, checkins24: +totals.checkins24, rating: prev.kpis.rating, reviews: prev.kpis.reviews,
    paying: +totals.paying, dauLatest: dau.length ? +dau[dau.length - 1].dau : prev.kpis.dauLatest,
    prayedEver: +totals.prayed, leaked: totals.app_opens - totals.prayed,
    active30: +(100 * totals.mau30 / totals.prayed).toFixed(1),
  },
  signups: signups.map(r => [r.d, +r.anon, +r.g, +r.a]),
  dau: dau.map(r => [r.d, +r.dau, +r.c]),
  outcomes: outcomes.map(r => [OUTLABEL[r.s] || r.s, +r.n]),
  activationByType: [['Anonymous', +(tmap.anonymous?.pct || 0), +(tmap.anonymous?.n || 0)],
                     ['Google', +(tmap.google?.pct || 0), +(tmap.google?.n || 0)],
                     ['Apple', +(tmap.apple?.pct || 0), +(tmap.apple?.n || 0)]],
  cohort: cohort.map(r => [r.m, +r.pct]),
};

// ---- GitHub commit heatmap (only if a PAT with access is provided) ----
const PAT = process.env.GH_PAT;
if (PAT) {
  const repos = ['GhanyR/fiveprayer-website', 'GhanyR/fiveprayer-backend', 'pislm/fiveprayer-mobile', 'GhanyR/fiveprayer-dashboard'];
  const daily = {}; const perRepo = [];
  for (const r of repos) {
    let n = 0, page = 1;
    while (true) {
      const res = await fetch(`https://api.github.com/repos/${r}/commits?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${PAT}`, 'User-Agent': 'fiveprayer-dashboard' } });
      if (!res.ok) break;
      const arr = await res.json(); if (!arr.length) break;
      for (const c of arr) { const d = c.commit.author.date.slice(0, 10); daily[d] = (daily[d] || 0) + 1; n++; }
      if (arr.length < 100) break; page++;
    }
    perRepo.push([r.split('/')[1], n]);
  }
  data.github = { daily, perRepo, total: Object.values(daily).reduce((a, b) => a + b, 0), activeDays: Object.keys(daily).length };
}

writeFileSync('data.json', JSON.stringify(data));
console.log('refreshed data.json — DAU days', data.dau.length, 'signup days', data.signups.length, 'app opens', data.kpis.appOpens);
