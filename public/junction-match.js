/* junction-match.js: the bridge between the Junction matchmaking UI (NovaThetop/junction-matchmaker)
 * and the spoilers matching backend. Load it BEFORE the page script:
 *   <script src="https://<backend>/junction-match.js"></script>
 * It sets window.JunctionMatch = { compatibility, simulate, explain, analyzeProfile, demoProfile }; clicking a
 * filled "% match" pill opens an explanation panel.
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
  const teamMembers = t => (t.memberIds || []).map(user).filter(Boolean);
  function publicTeam(t) {
    if (!t) return null;
    return {
      id: t.id, name: t.name, bio: t.bio || '', lookingFor: arr(t.lookingFor), openSpots: t.openSpots,
      members: teamMembers(t).map((m, i) => publicUser(m, 'Member' + (i + 1))),   // no space: the backend keeps the first word
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
      if (realPrediction(r.prediction) && !simCache.has(key)) simCache.set(key, Promise.resolve(namedPrediction(r.prediction, soloId, teamId)));
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
      return r ? { score: r.score, reasons: voice(r.reasons, soloId, teamId) } : null;
    } catch (e) {
      try { const r = localScore(soloId, teamId); return r && { score: r.score, reasons: r.reasons }; } catch (_) { return null; }
    }
  }

  // display only: backend reasons are in the solo's voice; when a team views a solo, say it to the team
  // the backend only ever saw "Builder" / "MemberN" for demo people; put their local first names back
  function unlabel(text, soloId, teamId) {
    if (typeof text !== 'string') return text;
    const members = team(teamId) ? teamMembers(team(teamId)) : [];
    return text.replace(/\bMember(\d+)\b/g, (m, i) => firstName(members[i - 1]?.name) || m)
      .replace(/\bBuilder\b/g, m => (user(soloId)?.demo && firstName(user(soloId).name)) || m);
  }
  function namedPrediction(pred, soloId, teamId) {
    const u = x => unlabel(x, soloId, teamId);
    return { ...pred, headsUp: u(pred.headsUp), spoiler: (pred.spoiler || []).map(e => ({ ...e, who: u(e.who), what: u(e.what) })) };
  }
  function voice(reasons, soloId, teamId) {
    const st = state(), teamView = !!st?.me && soloId !== st.me;
    const n = firstName(user(soloId)?.name) || 'They';
    return reasons.map(x => unlabel(x, soloId, teamId)).map(x => {
      if (teamView) {
        x = x.replace(/^They're missing (a|an) (.+?) person, and that's you\./, (_, a, role) => `You're missing ${a} ${role} person, and ${n} fits.`)
          .replace(/^You bring (.+?), which nobody there has\./, (_, skills) => `${n} brings ${skills}, which nobody on your team has.`);
      }
      return x.replace(/\ba AI\b/g, 'an AI');
    });
  }

  function simulate(soloId, teamId) {
    const key = soloId + '|' + teamId;
    if (simCache.has(key)) return simCache.get(key);
    const body = payload(soloId, teamId, 'simulate');
    if (!body) return Promise.resolve(null);
    const p = post(body, SIM_MAX_MS).then(r => realPrediction(r?.prediction)).catch(() => null)
      .then(pred => { if (!pred) simCache.delete(key); return pred && namedPrediction(pred, soloId, teamId); });
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

  /* ---------- explain panel: click a "% match" pill ---------- */
  const EXPLAIN_MAX_MS = 25000;
  const explainCache = new Map();
  const viewerOf = soloId => (soloId === state()?.me ? 'solo' : 'team');
  const deepUnlabel = (x, soloId, teamId) => typeof x === 'string' ? unlabel(x, soloId, teamId)
    : Array.isArray(x) ? x.map(y => deepUnlabel(y, soloId, teamId))
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepUnlabel(v, soloId, teamId)])) : x;

  function explain(soloId, teamId, viewer = viewerOf(soloId)) {
    const key = soloId + '|' + teamId + '|' + viewer;
    if (explainCache.has(key)) return explainCache.get(key);
    const body = payload(soloId, teamId, 'explain');
    if (!body) return Promise.resolve(null);
    const p = post({ ...body, viewer }, EXPLAIN_MAX_MS).then(r => {
      const e = r?.explain;
      if (!e || !Array.isArray(e.twoWeeks) || !e.twoWeeks.length) return null;
      return deepUnlabel({ ...r, reasons: arr(r.reasons).filter(okReason) }, soloId, teamId);
    }).catch(() => null).then(r => { if (!r) explainCache.delete(key); return r; });
    explainCache.set(key, p);
    return p;
  }

  // rules content when the AI explanation isn't available: only facts from both profiles
  function rulesExplain(soloId, teamId, reasons, sim) {
    const s = user(soloId), t = team(teamId);
    const members = teamMembers(t).filter(m => m.id !== s.id);
    const teamView = viewerOf(soloId) === 'team';
    const sName = firstName(s.name) || 'They';
    const lc = xs => new Set(xs.map(x => x.toLowerCase()));
    const sRoles = arr(s.roles), sSkills = arr(s.skills), sInt = arr(s.interests);
    const mRoles = [...new Set(members.flatMap(m => arr(m.roles)))], mSkills = [...new Set(members.flatMap(m => arr(m.skills)))];
    const mInt = [...new Set(members.flatMap(m => arr(m.interests)))];
    const only = (a, b) => a.filter(x => !lc(b).has(x.toLowerCase()));
    const both = (a, b) => a.filter(x => lc(b).has(x.toLowerCase()));
    const soloSide = { roles: only(sRoles, mRoles), skills: only(sSkills, mSkills) };
    const teamSide = { roles: only(mRoles, sRoles), skills: only(mSkills, sSkills) };
    const [you, them] = teamView ? [teamSide, soloSide] : [soloSide, teamSide];
    const complement = [];
    if (you.roles.length || them.roles.length) complement.push({ you: you.roles.join(', ') || 'same roles', them: them.roles.join(', ') || 'same roles', together: `Roles covered: ${[...new Set([...sRoles, ...mRoles])].join(', ')}` });
    if (you.skills.length || them.skills.length) complement.push({ you: you.skills.join(', ') || 'same skills', them: them.skills.join(', ') || 'same skills', together: `${new Set([...sSkills, ...mSkills].map(x => x.toLowerCase())).size} distinct skills between you` });

    const risks = [];
    const sameTop = members.find(m => arr(m.roles)[0] && arr(m.roles)[0] === sRoles[0]);
    if (sameTop) risks.push({ trait: `${sName} and ${firstName(sameTop.name)} both lead with ${sRoles[0]}`, risk: 'Both want the same job', tip: 'Split it on day one: one owns the core, the other owns integration and the demo.' });
    const sSpan = span(s.awake);
    const sameSleep = sSpan && members.find(m => { const x = span(m.awake); return x && Math.abs(((x[1] - sSpan[1]) % 1440 + 1440 + 720) % 1440 - 720) <= 60; });
    if (sameSleep) risks.push({ trait: `${sName} ${s.awake.from}–${s.awake.to}, ${firstName(sameSleep.name)} ${sameSleep.awake.from}–${sameSleep.awake.to}`, risk: 'You crash at the same time', tip: 'Stagger one sleep block so someone is awake for the last stretch before the deadline.' });
    const sharedSkills = both(sSkills, mSkills);
    if (sharedSkills.length) {
      const gap = arr(t.lookingFor).find(r => !lc([...sRoles, ...mRoles]).has(r.toLowerCase()));
      risks.push({ trait: `Both list ${list(sharedSkills)}`, risk: `Duplicated work${gap ? `, and still nobody on ${gap}` : ', and a gap somewhere else'}`, tip: 'Pair on it once, then one of you takes the part nobody owns.' });
    }
    const sharedInt = both(sInt, mInt);
    if (sharedInt.length) risks.push({ trait: `Both into ${list(sharedInt)}`, risk: 'Tunnel vision: easy to agree, nobody questions the idea', tip: 'Ask one outsider to poke holes before you lock the scope.' });
    if (!risks.length) risks.push({ trait: 'Few shared traits', risk: 'Different instincts can slow decisions', tip: 'Agree up front who makes the final scope call.' });

    const twoWeeks = (sim?.spoiler || []).map(e => ({ day: e.time || '', title: e.who || '', what: e.what || '' }));
    if (sim?.headsUp) twoWeeks.push({ day: 'Heads-up', title: '', what: sim.headsUp });
    const score = Math.round(Number(String(reasons.score ?? '').replace(/\D/g, '')) || 0);
    const verdict = score >= 75 ? 'Strong fit: send the request.'
      : score >= 55 ? `Good fit with one thing to talk through first: ${risks[0].risk.toLowerCase()}.`
      : `Worth a chat, but check this first: ${risks[0].risk.toLowerCase()}.`;
    return {
      label: 'AI agent explanation + simulation: a prediction, not a fact',
      headline: '', whyYouFit: reasons.list, complement, twoWeeks, timelineTitle: twoWeeks.length ? 'Simulated weekend' : '',
      similarityRisks: risks, verdict, source: 'rules',
    };
  }

  const CSS = `
.compat.on,.match.compat:not(.none){cursor:pointer}
.jm-back{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px}
.jm-modal{background:#232323;border:1px solid #3c3c3c;border-radius:16px;color:#fff;font-family:Montserrat,system-ui,sans-serif;width:min(680px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.jm-body{overflow:auto;padding:22px 24px 8px}
.jm-label{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:#8e908e;margin-bottom:10px}
.jm-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.jm-top h2{margin:0;font-size:20px;line-height:1.3}
.jm-x{background:none;border:0;color:#8e908e;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px}
.jm-pill{display:inline-block;margin-top:10px;border-radius:99px;padding:4px 11px;font-size:12.5px;font-weight:700;background:#78ce8d;color:#000}
.jm-head{color:#eaeaea;margin:12px 0 0;font-size:15px}
.jm-sec{background:#2b2b2b;border:1px solid #3c3c3c;border-radius:12px;padding:14px 16px;margin-top:14px}
.jm-sec h3{margin:0 0 8px;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:#78ce8d}
.jm-sec ul{margin:0;padding-left:18px}.jm-sec li{margin:3px 0;color:#eaeaea;font-size:14px}
.jm-status{margin-top:14px;color:#8e908e;font-size:14px;display:flex;gap:10px;align-items:center}
.jm-dot{width:8px;height:8px;border-radius:50%;background:#78ce8d;animation:jm-p 1s infinite alternate}
@keyframes jm-p{from{opacity:.25}to{opacity:1}}
.jm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13.5px}
.jm-grid b{font-size:11.5px;color:#8e908e;text-transform:uppercase;letter-spacing:.03em}
.jm-grid div{color:#eaeaea}
.jm-tl{list-style:none;padding:0 !important;margin:0;border-left:2px solid #3e5944}
.jm-tl li{padding:0 0 10px 14px;position:relative}
.jm-tl li:before{content:'';position:absolute;left:-6px;top:6px;width:10px;height:10px;border-radius:50%;background:#78ce8d}
.jm-tl .d{font-size:12px;color:#8e908e}
.jm-risk{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13.5px;padding:8px 0;border-top:1px solid #3c3c3c}
.jm-risk:first-of-type{border-top:0}
.jm-risk span{color:#eaeaea}.jm-risk em{color:#8e908e;font-style:normal;font-size:11.5px;text-transform:uppercase;display:block}
.jm-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 24px;border-top:1px solid #3c3c3c}
.jm-btn{font:700 14px Montserrat,system-ui,sans-serif;border-radius:10px;padding:10px 16px;cursor:pointer;border:0;background:#78ce8d;color:#000}
.jm-btn.ghost{background:transparent;color:#fff;border:1px solid #3c3c3c}
.jm-btn:disabled{opacity:.55;cursor:default}
@media (max-width:600px){.jm-back{padding:0}.jm-modal{width:100%;height:100%;max-height:none;border-radius:0;border:0}
.jm-grid,.jm-risk{grid-template-columns:1fr}.jm-body{padding:18px 16px 8px}.jm-foot{padding:12px 16px}}`;

  let open = null;   // { el, token, prevOverflow }
  function closePanel() {
    if (!open) return;
    open.el.remove();
    document.body.style.overflow = open.prevOverflow;
    open = null;
  }

  function sectionsHtml(x, teamView, sName) {
    const e = escHtml, li = xs => xs.map(v => `<li>${e(v)}</li>`).join('');
    let h = '';
    if (x.headline) h += `<p class="jm-head">${e(x.headline)}</p>`;
    if (arr(x.whyYouFit).length) h += `<div class="jm-sec"><h3>Why you'd work well</h3><ul>${li(arr(x.whyYouFit))}</ul></div>`;
    const comp = (x.complement || []).filter(c => c && (c.you || c.them || c.together));
    if (comp.length) h += `<div class="jm-sec"><h3>How you complement each other</h3>${comp.map(c => `<div class="jm-grid"><div><b>You</b><br>${e(c.you)}</div><div><b>${teamView ? e(sName) : 'Them'}</b><br>${e(c.them)}</div><div><b>Together</b><br>${e(c.together)}</div></div>`).join('<div style="height:10px"></div>')}</div>`;
    const tl = (x.twoWeeks || []).filter(d => d && (d.title || d.what));
    if (tl.length) h += `<div class="jm-sec"><h3>${e(x.timelineTitle || 'Two weeks together')}</h3><ul class="jm-tl">${tl.map(d => `<li><div class="d">${e(d.day)}</div>${d.title ? `<b>${e(d.title)}</b> ` : ''}${e(d.what)}</li>`).join('')}</ul></div>`;
    const rk = (x.similarityRisks || []).filter(r => r && (r.trait || r.risk));
    if (rk.length) h += `<div class="jm-sec"><h3>Where it could rub</h3>${rk.map(r => `<div class="jm-risk"><span><em>Similar</em>${e(r.trait)}</span><span><em>Risk</em>${e(r.risk)}</span><span><em>Tip</em>${e(r.tip)}</span></div>`).join('')}</div>`;
    if (x.verdict) h += `<div class="jm-sec"><h3>Verdict</h3><div style="color:#eaeaea">${e(x.verdict)}</div></div>`;
    return h;
  }

  const pendingLabel = (req, teamView) => req.kind === 'invite'
    ? (teamView ? 'Invite sent' : 'Invited you: see Requests')
    : (teamView ? 'Wants to join: see Requests' : 'Request sent');
  async function openPanel(soloId, teamId, pillText) {
    closePanel();
    const s = user(soloId), t = team(teamId);
    if (!s || !t) return;
    const teamView = viewerOf(soloId) === 'team';
    const sName = firstName(s.name) || 'They';
    const token = {};
    if (!document.getElementById('jm-style')) {
      const st = document.createElement('style'); st.id = 'jm-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    const back = document.createElement('div');
    back.className = 'jm-back';
    const title = teamView ? `Why ${sName} fits your team` : `Why you fit ${t.name}`;
    const pending = (() => { try { return typeof findReq === 'function' ? findReq(soloId, teamId) : null; } catch (e) { return null; } })();   // eslint-disable-line no-undef
    const canAsk = (() => { try { return typeof sendRequest === 'function'; } catch (e) { return false; } })();   // eslint-disable-line no-undef
    const askLabel = teamView ? 'Invite to team' : 'Request to join';
    back.innerHTML = `<div class="jm-modal" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
      <div class="jm-body">
        <div class="jm-label">AI agent explanation + simulation: a prediction, not a fact</div>
        <div class="jm-top"><h2>${escHtml(title)}</h2><button class="jm-x" aria-label="Close" data-jm="close">×</button></div>
        <span class="jm-pill">${escHtml(pillText || '')}</span>
        <div class="jm-sec" data-jm="reasons" hidden><h3>Fit</h3><ul></ul></div>
        <div class="jm-status" data-jm="status"><span class="jm-dot"></span>Your agent is test-driving two weeks with ${escHtml(teamView ? sName : t.name)}…</div>
        <div data-jm="sections"></div>
      </div>
      <div class="jm-foot">
        ${canAsk ? `<button class="jm-btn" data-jm="ask" ${pending ? 'disabled' : ''}>${pending ? pendingLabel(pending, teamView) : askLabel}</button>` : ''}
        <button class="jm-btn ghost" data-jm="close">Close</button>
      </div></div>`;
    open = { el: back, token, prevOverflow: document.body.style.overflow };
    document.body.style.overflow = 'hidden';
    document.body.appendChild(back);
    back.querySelector('.jm-x').focus();
    back.addEventListener('click', ev => {
      if (ev.target === back || ev.target.closest('[data-jm=close]')) return closePanel();
      const ask = ev.target.closest('[data-jm=ask]');
      if (ask && !ask.disabled) {
        try { sendRequest(teamView ? 'invite' : 'join_request', soloId, teamId); } catch (e) {}   // eslint-disable-line no-undef
        ask.disabled = true; ask.textContent = teamView ? 'Invite sent' : 'Request sent';
      }
    });
    const live = () => open && open.token === token;

    const fitR = await compatibility(soloId, teamId).catch(() => null);
    const reasons = arr(fitR?.reasons);
    if (!live()) return;
    if (reasons.length) {
      const box = back.querySelector('[data-jm=reasons]');
      box.hidden = false; box.querySelector('ul').innerHTML = reasons.map(x => `<li>${escHtml(x)}</li>`).join('');
    }
    let x = await explain(soloId, teamId, teamView ? 'team' : 'solo').catch(() => null);
    if (!live()) return;
    if (x) {
      x = { ...x.explain, timelineTitle: 'Two weeks together' };
    } else {
      const sim = await Promise.race([simulate(soloId, teamId).catch(() => null), sleep(4000).then(() => null)]);
      if (!live()) return;
      x = rulesExplain(soloId, teamId, { list: reasons.length ? reasons : (localScore(soloId, teamId)?.reasons || []), score: fitR?.score ?? pillText }, sim);
    }
    back.querySelector('[data-jm=status]').remove();
    back.querySelector('[data-jm=sections]').innerHTML = sectionsHtml(x, teamView, sName);
    back.querySelector('[data-jm=reasons]').hidden = true;   // the sections carry the reasons from here on
  }

  document.addEventListener('click', ev => {
    // any filled pill in either UI version (".compat.on" or ".match.compat"); never the simulation box
    const pill = ev.target.closest?.('[data-solo][data-team]');
    if (!pill || pill.closest('.prediction') || !/\d+% match/.test(pill.textContent)) return;
    ev.preventDefault(); ev.stopPropagation();
    try { openPanel(pill.dataset.solo, pill.dataset.team, pill.textContent.trim()).catch(() => {}); } catch (e) {}
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && open) closePanel(); });

  window.JunctionMatch = { compatibility, simulate, explain, analyzeProfile, demoProfile, apiBase: BASE };
})();
