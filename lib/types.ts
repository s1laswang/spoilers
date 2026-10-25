export const ROLES = ["design", "code", "hardware", "AI", "business"] as const;
export type Role = (typeof ROLES)[number];

export const INTERESTS = [
  "AI", "health", "climate", "fintech", "gaming", "hardware", "space", "mobility",
  "education", "security", "music", "social impact", "robotics", "defense", "energy", "food",
] as const;

/** Clock times like "09:00"; `to` may be past midnight ("03:00"). */
export type Awake = { from: string; to: string };

/**
 * The fields Junction's registration already collects, plus the three the brief needs
 * (skills, preferredRole, awake). No contact data: it never reaches the model.
 */
export type Participant = {
  id?: string;
  firstName: string;
  background: string;
  studyWork: string;
  proudProject: string;
  interests: string[];
  motivation: string;
  githubUrl?: string;
  skills: string[];
  preferredRole: Role;
  awake: Awake;
  /** false when the profile had no hours and `awake` is only a default; never shown as a fact then. */
  awakeListed?: boolean;
};

export type Team = {
  id: string;
  name: string;
  idea: string;
  tags: string[];
  missingRoles: Role[];
  members: Participant[];
};

export type Decline = { teamId: string; reason: "role" | "interests" | "schedule" | "not_it" };

export type Persona = {
  summary: string;
  workingStyle: string;
  pushesFor: string;
  likelyFriction: string;
};

export type Moment = { time: string; who: string; what: string };

export type Run = {
  crisis: string;
  solo_role: string;
  moments: Moment[];
  conflicts: string[];
  solo_contribution: "core" | "helpful" | "sidelined";
  outcome: "shipped" | "partial" | "fell_apart";
  one_liner: string;
};

export type FitFacts = { role: string; skills: string; interests: string; availability: string };

export type Fit = {
  score: number;
  parts: { role: number; skills: number; interests: number; availability: number };
  facts: FitFacts;
};

export type Match = {
  teamId: string;
  teamName: string;
  idea: string;
  compatibility: number;
  shippedRuns: number;
  totalRuns: number;
  why: string;
  fit: FitFacts;
  fitParts: Fit["parts"];
  spoiler: Moment[];
  headsUp: string;
  soloRole: string;
};
