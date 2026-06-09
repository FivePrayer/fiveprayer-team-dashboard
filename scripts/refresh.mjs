// Regenerates data.json from live sources. Run by .github/workflows/refresh-data.yml on a schedule.
// Requires secret SUPABASE_DB_URL (read-only Postgres connection string from Supabase → Settings → Database).
// Optional secret GH_PAT (fine-grained PAT with read access to the 4 repos) to also refresh the commit heatmap.
import pg from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

const prev = JSON.parse(readFileSync('data.json', 'utf8')); // preserve sections we can't refresh
const MQ = existsSync('scripts/metric_queries.json') ? JSON.parse(readFileSync('scripts/metric_queries.json', 'utf8')) : {};
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

// ---- high-leverage metrics (each independent; failure preserves the previous value) ----
const M = {};
try { const r = await q(MQ.retention); M.retention = r.map(function (x) { return { cohortWeek: String(x.cohort_week), size: +x.size, d1: x.d1 == null ? null : +x.d1, d7: x.d7 == null ? null : +x.d7, d30: x.d30 == null ? null : +x.d30 }; }); } catch (e) { console.log('m.retention', e.message); }
try { const r = await q(MQ.geo); M.geo = { countries: r.map(function (x) { return [x.country, +x.cnt]; }), countries_pct: r.map(function (x) { return [x.country, +x.pct]; }), languages: [] }; } catch (e) { console.log('m.geo', e.message); }
try { const r = (await q(MQ.streaks))[0]; M.streaks = { buckets: [{ label: '0', users: +r.bucket_0 }, { label: '1-2', users: +r.bucket_1_2 }, { label: '3-6', users: +r.bucket_3_6 }, { label: '7-13', users: +r.bucket_7_13 }, { label: '14-29', users: +r.bucket_14_29 }, { label: '30-59', users: +r.bucket_30_59 }, { label: '60+', users: +r.bucket_60_plus }], total_users: +r.total_users, streak_ge7: { users: +r.streak_ge7, pct: +r.pct_ge7 }, streak_ge30: { users: +r.streak_ge30, pct: +r.pct_ge30 }, max_longest_streak: +r.max_longest_streak }; } catch (e) { console.log('m.streaks', e.message); }
try { const a = (await q(MQ.stickDauMau))[0]; const s = await q(MQ.stickSeries); M.stickiness = { dauMau: +a.dau_mau, dau: +a.dau, mau: +a.mau, series: s.map(function (x) { return [String(x.week_end), x.mau ? +(x.dau / x.mau).toFixed(3) : null]; }) }; } catch (e) { console.log('m.stick', e.message); }
try { const r = await q(MQ.engagement); M.engagement = { byPrayer: r.map(function (x) { return [x.prayer_name, +x.total, +x.on_time_pct, +x.late_pct, +x.missed_pct]; }) }; } catch (e) { console.log('m.eng', e.message); }
console.log('metrics:', Object.keys(M).join(','));

await db.end();

const OUTLABEL = { on_time: 'On time', late: 'Late', missed: 'Missed', menstruation: 'Menstruation' };
const data = {
  ...prev,
  ...M,
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

// ---- Stores: App Store Connect + Google Play (uses env secrets in CI, .secrets/ locally) ----
try {
  const b64url = (s) => Buffer.from(s).toString('base64url');
  const p8 = process.env.APPSTORE_P8 || (existsSync('.secrets/AppStoreConnect_AuthKey_2GHDN4JLDT.p8') ? readFileSync('.secrets/AppStoreConnect_AuthKey_2GHDN4JLDT.p8', 'utf8') : null);
  const saRaw = process.env.PLAY_SA_JSON || (existsSync('.secrets/play-service-account.json') ? readFileSync('.secrets/play-service-account.json', 'utf8') : null);
  const stores = {};
  if (p8) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.APPSTORE_KEY_ID || '2GHDN4JLDT', typ: 'JWT' }));
    const pl = b64url(JSON.stringify({ iss: process.env.APPSTORE_ISSUER_ID || '0c7e62df-b701-4b2b-9717-7b3c2b3590e6', iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' }));
    const jwt = h + '.' + pl + '.' + crypto.sign('SHA256', Buffer.from(h + '.' + pl), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    let url = 'https://api.appstoreconnect.apple.com/v1/apps/6755536905/customerReviews?limit=200&sort=-createdDate';
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let total = 0, sum = 0, pg2 = 0; const recent = [];
    while (url && pg2 < 8) {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + jwt } }); if (!r.ok) break; const j = await r.json();
      for (const rv of (j.data || [])) { const s = rv.attributes?.rating; if (s) { dist[s]++; total++; sum += s; } if (recent.length < 6) recent.push({ rating: s, title: rv.attributes?.title, body: (rv.attributes?.body || '').slice(0, 120), territory: rv.attributes?.territory }); }
      url = j.links?.next; pg2++;
    }
    stores.ios = { rating: total ? +(sum / total).toFixed(2) : null, reviews: total, dist, recent };
  }
  if (saRaw) {
    const sa = JSON.parse(saRaw); const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const pl = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri, iat: now, exp: now + 3600 }));
    const assertion = h + '.' + pl + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + pl), sa.private_key).toString('base64url');
    const tok = (await (await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })).json()).access_token;
    const revs = (await (await fetch('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.fiveprayer.app/reviews?maxResults=100', { headers: { Authorization: 'Bearer ' + tok } })).json()).reviews || [];
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let sum = 0, n = 0; const recent = [];
    for (const rv of revs) { const c = rv.comments?.[0]?.userComment; const s = c?.starRating; if (s) { dist[s]++; sum += s; n++; } if (recent.length < 6) recent.push({ rating: s, text: (c?.text || '').slice(0, 120), device: c?.deviceMetadata?.productName, author: rv.authorName }); }
    stores.play = { ratingAllTime: prev.stores?.play?.ratingAllTime || 4.82, reviewsAllTime: prev.stores?.play?.reviewsAllTime || 94261, ratingLast7d: n ? +(sum / n).toFixed(2) : null, distLast7d: dist, recent };
  }
  if (stores.ios || stores.play) data.stores = { ...prev.stores, ...stores, pulledAt: new Date().toISOString() };
  console.log('stores:', stores.ios?.rating, '/', stores.play?.ratingLast7d);
} catch (e) { console.log('stores ERROR (kept previous):', e.message); }

// ---- live reach-out activity from the Sheet's ActivityLog Web App (server-side; no CORS) ----
try {
  const alUrl = data.activityLogUrl || prev.activityLogUrl;
  if (alUrl) {
    const j = JSON.parse(await (await fetch(alUrl, { redirect: 'follow' })).text()); // throws if login-gated (HTML)
    if (j && j.byDay) {
      const hist = (data.reachoutHistory && data.reachoutHistory.byDay) || {};
      const merged = { ...hist };
      for (const k in j.byDay) merged[k] = Math.max(merged[k] || 0, j.byDay[k]);
      data.reachoutHistory = { ...data.reachoutHistory, byDay: merged, liveUpdatedAt: j.generatedAt, source: 'Sheet version history + live ActivityLog' };
      console.log('reachout live merged:', Object.keys(j.byDay).length, 'days');
    }
  }
} catch (e) { console.log('activitylog fetch skipped:', e.message); }

// ---- Android Vitals (crash + ANR) via Play Reporting API ----
try {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const saRaw = process.env.PLAY_SA_JSON || (existsSync('.secrets/play-service-account.json') ? readFileSync('.secrets/play-service-account.json', 'utf8') : null);
  if (saRaw) {
    const sa = JSON.parse(saRaw); const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const pl = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/playdeveloperreporting', aud: sa.token_uri, iat: now, exp: now + 3600 }));
    const assertion = h + '.' + pl + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + pl), sa.private_key).toString('base64url');
    const tok = (await (await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })).json()).access_token;
    const end = new Date(Date.now() - 2 * 86400000), start = new Date(end.getTime() - 27 * 86400000);
    const dt = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    async function vq(ms, metric) {
      const body = { timelineSpec: { aggregationPeriod: 'DAILY', startTime: dt(start), endTime: dt(end) }, metrics: [metric], dimensions: [] };
      const r = await fetch('https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.fiveprayer.app/' + ms + ':query', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 200) return [];
      const j = await r.json();
      return (j.rows || []).map(function (row) { const d = row.startTime; const date = d.year + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0'); const m = (row.metrics || []).find(function (x) { return x.metric === metric; }); const v = m && (m.decimalValue ? m.decimalValue.value : m.value); return [date, v != null ? +(+v).toFixed(4) : null]; });
    }
    const crash = await vq('crashRateMetricSet', 'crashRate'), anr = await vq('anrRateMetricSet', 'anrRate');
    if (crash.length || anr.length) data.vitals = { crash, anr, pulledAt: new Date().toISOString() };
    console.log('vitals:', crash.length, '/', anr.length);
  }
} catch (e) { console.log('vitals ERROR (kept previous):', e.message); }

writeFileSync('data.json', JSON.stringify(data));
console.log('refreshed data.json — DAU days', data.dau.length, 'signup days', data.signups.length, 'app opens', data.kpis.appOpens);
