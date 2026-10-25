/* junction-match.js: the bridge between the Junction matchmaking UI (NovaThetop/junction-matchmaker)
 * and the spoilers matching backend. Load it BEFORE the page script:
 *   <script src="https://<backend>/junction-match.js"></script>
 * It sets window.JunctionMatch = { compatibility, simulate, analyzeProfile, demoProfile }.
 * The page keeps its state in a top-level `let S`; we read it at call time (shared global scope).
 * Plain browser JS, no dependencies, never throws into the page. */
(function () {
  'use strict';

  // API base = origin this file was served from, so the same file works on localhost and in prod.
  const BASE = (() => {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return location.origin; }
  })();
  const FIT_WAIT_MS = 2500;     // after this a pill gets the local score
  const FIT_MAX_MS = 30000;     // a late backend answer still replaces the local score on the next render
  const SIM_MAX_MS = 60000;
  const GH_TTL_MS = 6 * 3600 * 1000;

  const state = () => { try { return S; } catch (e) { return null; } };   // eslint-disable-line no-undef
  const user = id => state()?.users?.[id] || null;
  const team = id => state()?.teams?.[id] || null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const arr = x => (Array.isArray(x) ? x.filter(s => typeof s === 'string' && s.trim()) : []);
  const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
  const list = xs => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- privacy: what may leave the browser ---------- */
  // Demo (sample) people: only roles/skills/interests/awake/bio, nothing that identifies them; the backend needs
  // some first name, so they get a neutral label ("Builder", "Member 2") that says nothing about the person.
  // Real users: first name only; email, age, password and link URLs never leave.
  function publicUser(u, label = 'Builder') {
    if (!u) return null;
    const out = {};
    if (u.demo) {
      out.name = label;
      for (const k of ['roles', 'skills', 'interests', 'awake', 'bio']) if (u[k] != null) out[k] = u[k];
      return out;
    }
    // the hero ("Use demo profile") goes out as the backend's own record, verbatim and without evidence,
    // so its persona key is byte-identical to the pregenerated one
    if (isHero(u)) return { ...HERO_MODEL };
    out.id = u.id;
    out.name = firstName(u.name);
    for (const k of ['roles', 'skills', 'interests', 'awake', 'bio', 'mode', 'teamId']) if (u[k] != null) out[k] = u[k];
    // link URLs stay home (handles often carry the surname); the facts analyzeProfile read from GitHub go instead
    if (u.evidence?.evidence) out.evidence = arr(u.evidence.evidence);
    return out;
  }
  const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
  const isHero = u => u.id === 'me' && sameList(u.roles, demoProfile.roles) && sameList(u.skills, demoProfile.skills);
  function publicTeam(t) {
    if (!t) return null;
    return {
      id: t.id, name: t.name, bio: t.bio || '', lookingFor: arr(t.lookingFor), openSpots: t.openSpots,
      members: (t.memberIds || []).map(user).filter(Boolean).map((m, i) => publicUser(m, 'Member ' + (i + 1))),
    };
  }

  async function post(body, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(BASE + '/api/compatibility', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }

  /* ---------- local fallback: role gap 35, skill complement 25, interests 20, availability 20 ---------- */
  const mins = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
  function span(a) {
    const f = mins(a?.from), t = mins(a?.to);
    if (f == null || t == null) return null;
    return [f, t > f ? t : t + 1440];
  }
  function overlapMin(a, b) {
    let best = 0;
    for (const s of [-1440, 0, 1440]) best = Math.max(best, Math.min(a[1], b[1] + s) - Math.max(a[0], b[0] + s));
    return best;
  }

  function localScore(soloId, teamId) {
    const s = user(soloId), t = team(teamId);
    if (!s || !t) return null;
    const st = state();
    const members = (t.memberIds || []).map(user).filter(m => m && m.id !== s.id);
    const who = s.id === st?.me ? 'Your' : `${firstName(s.name)}'s`;
    const tName = st?.me && user(st.me)?.teamId === t.id ? 'your team' : t.name;
    const sRoles = arr(s.roles), sSkills = arr(s.skills), want = arr(t.lookingFor);
    const reasons = [];
    let score = 0;

    // role gap (35)
    const hit = sRoles.findIndex(r => want.includes(r));
    const memberRoles = new Set(members.flatMap(m => arr(m.roles)));
    const newRole = sRoles.find(r => !memberRoles.has(r));
    if (hit >= 0) {
      score += [35, 28, 21][hit] ?? 21;
      reasons.push(`${who} #${hit + 1} role, ${sRoles[hit]}, is one ${tName} is looking for`);
    } else if (!want.length) {
      score += newRole ? 18 : 8;
      if (newRole) reasons.push(`No one on ${tName} lists ${newRole} yet`);
    } else {
      score += newRole ? 10 : 0;
      reasons.push(`${tName} is looking for ${list(want)}; ${who.toLowerCase() === 'your' ? 'your' : who} roles are ${list(sRoles)}`);
    }

    // skill complement (25)
    const have = new Set(members.flatMap(m => arr(m.skills)).map(x => x.toLowerCase()));
    const fresh = sSkills.filter(x => !have.has(x.toLowerCase()));
    score += Math.round(25 * fresh.length / Math.max(1, sSkills.length));
    if (fresh.length) reasons.push(`Brings ${list(fresh)}, which no one on ${tName} lists`);
    else if (sSkills.length) reasons.push(`${tName} already covers ${list(sSkills)}`);

    // interest overlap (20); no data on either side = neutral, no reason
    const sInt = arr(s.interests);
    const tInt = new Set(members.flatMap(m => arr(m.interests)).map(x => x.toLowerCase()));
    const bio = String(t.bio || '').toLowerCase();
    if (sInt.length && (tInt.size || bio)) {
      const shared = sInt.filter(i => tInt.has(i.toLowerCase()) || new RegExp(`\\b${i.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bio));
      score += shared.length >= 2 ? 20 : shared.length ? 14 : 4;
      if (shared.length) reasons.push(`Shared interests: ${list(shared)}`);
    } else score += 10;

    // availability overlap (20)
    const sSpan = span(s.awake), mSpans = members.map(m => [m, span(m.awake)]).filter(([, x]) => x);
    if (sSpan && mSpans.length) {
      const worst = mSpans.map(([m, x]) => [m, overlapMin(sSpan, x)]).sort((a, b) => a[1] - b[1])[0];
      const h = Math.round(Math.max(0, worst[1]) / 60);
      score += Math.round(20 * Math.min(1, h / 12));
      reasons.push(`Awake ${s.awake.from}–${s.awake.to}: ${h} h overlap with ${firstName(worst[0].name) || 'the team'} (${worst[0].awake.from}–${worst[0].awake.to})`);
    } else score += 10;

    return { score: Math.max(5, Math.min(98, score)), reasons: reasons.map(x => x[0].toUpperCase() + x.slice(1)), source: 'local' };
  }

  /* ---------- backend calls, cached per pair ---------- */
  const fitCache = new Map(), simCache = new Map();
  const TIMEOUT = Symbol('timeout');
  // a prediction with no runs behind it is no prediction
  const realPrediction = x => (x && (x.totalRuns > 0 || x.spoiler?.length) ? x : null);
  // drop half-built sentences from the backend, e.g. "Different interests: they're about ." (empty list)
  const okReason = x => !/(\s|:)[.,;]?\s*$|\b(about|for|with|of|in|like|and)\s*[.,]?\s*$|\(\s*\)|undefined|null/i.test(x.trim());

  function payload(soloId, teamId, mode) {
    const s = publicUser(user(soloId)), t = publicTeam(team(teamId));
    return s && t ? { solo: s, team: t, mode } : null;
  }

  function fit(soloId, teamId) {
    const key = soloId + '|' + teamId;
    if (fitCache.has(key)) return fitCache.get(key);
    const body = payload(soloId, teamId, 'fit');
    if (!body) return Promise.resolve(localScore(soloId, teamId));
    const net = post(body, FIT_MAX_MS).then(r => {
      if (!r || typeof r.score !== 'number') return null;
      if (realPrediction(r.prediction) && !simCache.has(key)) simCache.set(key, Promise.resolve(r.prediction));
      return { score: r.score, reasons: arr(r.reasons).filter(okReason), source: r.source || 'backend' };
    });
    const p = Promise.race([net, sleep(FIT_WAIT_MS).then(() => TIMEOUT)]).then(r => {
      if (r && r !== TIMEOUT) return r;
      if (r === TIMEOUT) {
        // keep waiting in the background; a late answer wins on the next render, a failure allows a retry
        net.then(late => { if (late) fitCache.set(key, Promise.resolve(late)); else fitCache.delete(key); });
      } else fitCache.delete(key);
      return localScore(soloId, teamId);
    }).catch(() => localScore(soloId, teamId));
    fitCache.set(key, p);
    return p;
  }

  async function compatibility(soloId, teamId) {
    try {
      // fillCompat awaits pills one by one; fire every visible pair at once so they land together
      for (const el of document.querySelectorAll('.compat[data-solo]')) fit(el.dataset.solo, el.dataset.team);
      const r = await fit(soloId, teamId);
      return r ? { score: r.score, reasons: r.reasons } : null;
    } catch (e) {
      try { const r = localScore(soloId, teamId); return r && { score: r.score, reasons: r.reasons }; } catch (_) { return null; }
    }
  }

  function simulate(soloId, teamId) {
    const key = soloId + '|' + teamId;
    if (simCache.has(key)) return simCache.get(key);
    const body = payload(soloId, teamId, 'simulate');
    if (!body) return Promise.resolve(null);
    const p = post(body, SIM_MAX_MS).then(r => realPrediction(r?.prediction)).catch(() => null)
      .then(pred => { if (!pred) simCache.delete(key); return pred; });
    simCache.set(key, p);
    return p;
  }

  /* ---------- analyzeProfile: public GitHub evidence only ---------- */
  // LinkedIn and other links are never fetched: LinkedIn's API doesn't expose skills and scraping breaks its terms.
  const TOPIC_SKILLS = {
    react: 'React', typescript: 'TypeScript', python: 'Python', nodejs: 'Node.js', node: 'Node.js', figma: 'Figma',
    pytorch: 'PyTorch', sql: 'SQL', flutter: 'Flutter', swift: 'Swift', arduino: 'Arduino', cpp: 'C++', docker: 'Docker',
    fastapi: 'FastAPI', nextjs: 'Next.js', 'next-js': 'Next.js', rust: 'Rust', go: 'Go', golang: 'Go', pandas: 'Pandas',
    llm: 'LLMs', llms: 'LLMs', openai: 'LLMs', unity: 'Unity', 'machine-learning': 'Machine learning',
    'computer-vision': 'Computer vision', robotics: 'Robotics', embedded: 'Embedded', esp32: 'Embedded', kicad: 'PCB design',
  };
  const LANG_SKILLS = { 'C++': 'C++', 'Jupyter Notebook': 'Python', Dart: 'Flutter', 'C#': 'C#' };

  function ghHandle(link) {
    const h = String(link || '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(h) ? h : null;
  }
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  async function ghJson(path) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch('https://api.github.com' + path, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
      return res.ok ? await res.json() : null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }

  function summarise(profile, repos) {
    const own = repos.filter(r => !r.fork);
    const counts = {};
    for (const r of own) if (r.language) counts[r.language] = (counts[r.language] || 0) + 1;
    const langs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const withLang = langs.reduce((n, [, c]) => n + c, 0);
    const total = profile?.public_repos ?? repos.length;
    const evidence = [];
    if (langs.length) {
      const pct = Math.round(100 * langs[0][1] / withLang);
      evidence.push(total <= 30
        ? `${total} public repos, ${pct}% ${langs[0][0]}`
        : `${total} public repos; ${pct}% of the 30 most recently pushed are ${langs[0][0]}`);
    } else evidence.push(`${total} public repo${total === 1 ? '' : 's'}`);
    const fmt = d => new Date(d).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
    const latest = own.find(r => r.pushed_at);
    if (latest) evidence.push(`Built ${latest.name} (${latest.language ? latest.language + ', ' : ''}${fmt(latest.pushed_at)})`);
    const starred = own.filter(r => r.stargazers_count > 0 && r !== latest).sort((a, b) => b.stargazers_count - a.stargazers_count)[0];
    if (starred) evidence.push(`${starred.name}: ${starred.stargazers_count} star${starred.stargazers_count === 1 ? '' : 's'}${starred.language ? ' (' + starred.language + ')' : ''}`);
    const topics = {};
    for (const r of own) for (const t of r.topics || []) topics[t] = (topics[t] || 0) + 1;
    const topTopics = Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    if (topTopics.length) evidence.push(`Repo topics: ${topTopics.join(', ')}`);
    else if (langs.length > 1) evidence.push(`Also writes ${langs.slice(1, 4).map(([l]) => l).join(', ')}`);

    const inferred = [];
    for (const [l] of langs.slice(0, 4)) inferred.push(LANG_SKILLS[l] || l);
    for (const t of Object.keys(topics)) if (TOPIC_SKILLS[t]) inferred.push(TOPIC_SKILLS[t]);
    return { evidence: evidence.slice(0, 4), inferredSkills: [...new Set(inferred)].slice(0, 6) };
  }

  async function analyzeProfile(u) {
    try {
      if (!u || u.demo) return null;
      const handle = ghHandle(u.links?.github);
      if (!handle) return null;
      const key = 'jm_gh_' + handle.toLowerCase();
      let result = lsGet(key);
      if (!result || Date.now() - result.at > GH_TTL_MS) {
        const [profile, repos] = await Promise.all([
          ghJson(`/users/${handle}`),
          ghJson(`/users/${handle}/repos?sort=pushed&per_page=30`),
        ]);
        if (!profile || !Array.isArray(repos)) return null;
        result = { ...summarise(profile, repos), source: 'github.com/' + handle, at: Date.now() };
        lsSet(key, result);
      }
      const evidence = { evidence: result.evidence, inferredSkills: result.inferredSkills, source: result.source };
      const target = user(u.id);
      if (target) {
        target.evidence = evidence;
        try { if (typeof save === 'function') save(); } catch (e) {}   // eslint-disable-line no-undef
      }
      const slot = document.querySelector('#signup .slot');   // other .slot boxes (e.g. the simulation) aren't ours
      if (slot) {
        slot.innerHTML = `<b>From your GitHub (${escHtml(result.source)})</b><ul class="reasons">${evidence.evidence.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`
          + (evidence.inferredSkills.length ? `<div>Inferred skills: ${evidence.inferredSkills.map(escHtml).join(', ')}</div>` : '');
      }
      return evidence;
    } catch (e) { return null; }
  }

  /* ---------- the hero profile behind "Use demo profile" ---------- */
  // TODO(Silas): confirm these. The UI shape fills the signup form (flat fields for the button, links for a user
  // object); a signed-up "me" whose roles and skills equal these is sent to the backend as HERO_MODEL.
  const demoProfile = {
    id: 'me', name: 'Silas Wang', email: 'silas@example.com',
    roles: ['Hardware', 'Pitch & business', 'ML / AI'], skills: ['C++', 'Python', 'Pitching'],
    interests: ['hardware', 'space', 'robotics', 'defense', 'AI'], awake: { from: '09:00', to: '03:00' },
    linkedin: '', github: 'github.com/s1laswang', other: [],
    links: { linkedin: '', github: 'github.com/s1laswang', other: [] },
    mode: null, teamId: null,
  };
  // spoilers/data/participants.json[0] ("silas"), exactly the fields the backend's modelView() hashes.
  // Keep in sync with that record or the hero misses the pregenerated cache.
  const HERO_MODEL = {
    firstName: 'Silas',
    background: 'Founder',
    studyWork: 'Electrical engineer, STUHI, FR8',
    proudProject: 'Building a rocket with thrust-vector control',
    interests: ['hardware', 'space', 'robotics', 'defense', 'AI'],
    motivation: "I'm here to win",
    skills: ['PCB design', 'embedded C', 'control systems', 'CAD', 'Python', 'pitching'],
    preferredRole: 'hardware',
    awake: { from: '09:00', to: '03:00' },
  };

  window.JunctionMatch = { compatibility, simulate, analyzeProfile, demoProfile, apiBase: BASE };
})();
