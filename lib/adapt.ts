import { parseParticipant } from "./match";
import { INTERESTS, type Participant, type Role, type Team } from "./types";

/**
 * Accepts the teammate's Junction-platform shapes (MATCHMAKING.md in
 * NovaThetop/junction-matchmaker) as well as ours: users with roles[3] like
 * "Frontend" / "ML" / "PM" plus skills and links; teams with bio + lookingFor.
 */

const ROLE_MAP: [RegExp, Role][] = [
  [/design|ux|ui\b|figma|visual/i, "design"],
  [/\bml\b|\bai\b|machine|data|vision|nlp|llm/i, "AI"],
  [/hardware|electr|embedded|mechanic|robot|pcb/i, "hardware"],
  [/\bpm\b|product|pitch|business|sales|market|founder/i, "business"],
  [/front|back|full|dev|engineer|code|software|mobile|web/i, "code"],
];

export function toRole(s: unknown): Role | null {
  if (typeof s !== "string") return null;
  for (const [re, role] of ROLE_MAP) if (re.test(s)) return role;
  return null;
}

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/** Words in a free-text bio that point at one of our interest tags. */
const SYNONYMS: Record<string, RegExp> = {
  AI: /\bai\b|machine learning|\bml\b|llm|model/,
  health: /health|medical|wellbeing|heat stress|wearable/,
  climate: /climate|carbon|emission|waste|sustainab/,
  fintech: /fintech|finance|payment|bank|money/,
  gaming: /game|gaming/,
  hardware: /hardware|wearable|sensor|device|iot|arduino/,
  space: /space|satellite|orbit/,
  mobility: /mobility|traffic|transport|bike|delivery|route|smart city/,
  education: /education|edtech|study|student|lecture|quiz|learn/,
  security: /security|privacy|phishing/,
  music: /music|audio/,
  "social impact": /social|community|accessib|inclusive|buddy/,
  robotics: /robot|drone/,
  defense: /defen[cs]e|military/,
  energy: /energy|grid|battery|power/,
  food: /food|recipe|fridge|kitchen|meal|grocer/,
};

/** Interest tags we can recognise in free text (a team bio, a role list). */
export function tagsIn(text: string): string[] {
  const t = text.toLowerCase();
  return INTERESTS.filter((i) => SYNONYMS[i]?.test(t) || t.includes(i.toLowerCase()));
}

export function soloFromAny(x: unknown): Participant | null {
  const o = (x ?? {}) as Record<string, unknown>;
  if (typeof o.preferredRole === "string") {
    const p = parseParticipant(o);
    const evidence = strs(o.evidence);
    return p && evidence.length ? { ...p, proudProject: [p.proudProject, ...evidence].filter(Boolean).join("; ") } : p;
  }
  const name = typeof o.firstName === "string" ? o.firstName : typeof o.name === "string" ? o.name : "";
  const roles = strs(o.roles);
  const skills = strs(o.skills);
  // links is a list in our shape, {linkedin, github, other[]} in the platform's.
  const l = (o.links ?? {}) as Record<string, unknown>;
  const links = Array.isArray(o.links) ? strs(o.links) : [l.github, l.linkedin, ...strs(l.other)].filter((s): s is string => typeof s === "string");
  const role = roles.map(toRole).find(Boolean) ?? toRole(skills.join(" ")) ?? "code";
  const interests = strs(o.interests);
  return parseParticipant({
    id: o.id,
    firstName: name.split(" ")[0],
    background: roles.join(", "),
    studyWork: roles.join(", "),
    // GitHub facts the platform gathered (languages, repos): real signals the persona can lean on.
    proudProject: [...links, ...strs(o.evidence)].join("; "),
    interests: interests.length ? interests : tagsIn(`${roles.join(" ")} ${skills.join(" ")}`),
    motivation: "",
    skills,
    preferredRole: role,
    awake: o.awake ?? { from: "09:00", to: "01:00" },
  });
}

export function teamFromAny(x: unknown): Team | null {
  const o = (x ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  if (!name) return null;
  const idea = typeof o.idea === "string" ? o.idea : typeof o.bio === "string" ? o.bio : "";
  const missing = strs(o.missingRoles).length ? strs(o.missingRoles) : strs(o.lookingFor);
  const members = (Array.isArray(o.members) ? o.members : []).map(soloFromAny).filter((m): m is Participant => !!m);
  const tags = strs(o.tags).length
    ? strs(o.tags)
    : [...new Set([...tagsIn(`${name} ${idea}`), ...members.flatMap((m) => m.interests)])];
  return {
    id: typeof o.id === "string" ? o.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    idea,
    tags,
    missingRoles: [...new Set(missing.map(toRole).filter((r): r is Role => !!r))],
    members,
  };
}
