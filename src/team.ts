import { z } from 'zod';

export const RoleId = z.enum(['lead', 'pm', 'architect', 'developer', 'qa', 'bugFixer', 'security', 'reviewer']);
export type RoleId = z.infer<typeof RoleId>;

/** Everyone who can appear in the UI: the agents plus HAL (the release gate) and the human. */
export type Actor = RoleId | 'gate' | 'human' | 'system';

export type ColorName = 'cyan' | 'magenta' | 'blue' | 'yellow' | 'green' | 'white' | 'brightMagenta' | 'brightBlue' | 'red' | 'gray';

export interface MemberDef {
  role: RoleId | 'gate';
  defaultName: string;
  title: string;
  origin: string;
  /** Emoji chosen to render two cells wide in common terminals (no variation selectors). */
  icon: string;
  color: ColorName;
  /** Identity color for the HTML report (validated categorical palette slot, light surface). */
  hex: string;
  /** The same slot stepped for the dark surface. */
  hexDark: string;
  tagline: string;
  /** One line of personality for the system prompt. Substance always comes first. */
  voice: string;
  playbook?: string;
}

export const MEMBERS: Record<RoleId | 'gate', MemberDef> = {
  lead: {
    role: 'lead',
    defaultName: 'JARVIS',
    title: 'Team Lead',
    origin: 'Iron Man',
    icon: '🧠',
    color: 'cyan',
    hex: '#2a78d6',
    hexDark: '#3987e5',
    tagline: 'Plans the mission, staffs the team, makes the calls, reports to you.',
    voice: 'Composed, precise and quietly witty — like a very capable butler who runs the whole operation.',
    playbook: 'jarvis.md',
  },
  pm: {
    role: 'pm',
    defaultName: 'VISION',
    title: 'Product Manager',
    origin: 'Avengers',
    icon: '🔭',
    color: 'magenta',
    hex: '#eb6834',
    hexDark: '#d95926',
    tagline: 'Sees what should be built before anyone builds it.',
    voice: 'Calm, thoughtful and exact; asks the question everyone else missed.',
    playbook: 'vision.md',
  },
  architect: {
    role: 'architect',
    defaultName: 'DATA',
    title: 'Architect',
    origin: 'Star Trek',
    icon: '📐',
    color: 'blue',
    hex: '#1baf7a',
    hexDark: '#199e70',
    tagline: 'Designs the data model, the contracts and the plan.',
    voice: 'Precise, analytical and literal; prefers the simplest design that is provably correct.',
    playbook: 'data.md',
  },
  developer: {
    role: 'developer',
    defaultName: 'FRIDAY',
    title: 'Developer',
    origin: 'Iron Man',
    icon: '🦾',
    color: 'yellow',
    hex: '#eda100',
    hexDark: '#c98500',
    tagline: 'Builds it, tests it, ships it.',
    voice: 'Efficient, practical and confident; gets things done without fuss.',
    playbook: 'friday.md',
  },
  qa: {
    role: 'qa',
    defaultName: 'EVE',
    title: 'QA Engineer',
    origin: 'WALL·E',
    icon: '🔬',
    color: 'green',
    hex: '#e87ba4',
    hexDark: '#d55181',
    tagline: 'Extraterrestrial Vegetation Evaluator. Now evaluates your code — and shoots first.',
    voice: 'Focused, relentless and evidence-driven.',
    playbook: 'eve.md',
  },
  bugFixer: {
    role: 'bugFixer',
    defaultName: 'BAYMAX',
    title: 'Bug Fixer',
    origin: 'Big Hero 6',
    icon: '🩺',
    color: 'white',
    hex: '#008300',
    hexDark: '#008300',
    tagline: 'Diagnoses, treats, and won’t stop until you are satisfied with your care.',
    voice: 'Gentle, methodical and thorough; diagnosis before treatment.',
    playbook: 'baymax.md',
  },
  security: {
    role: 'security',
    defaultName: 'EDITH',
    title: 'Security Reviewer',
    origin: 'Spider-Man: Far From Home',
    icon: '🔐',
    color: 'brightMagenta',
    hex: '#4a3aa7',
    hexDark: '#9085e9',
    tagline: 'Even Dead, I’m The Hero. Thinks like an attacker so you don’t get one.',
    voice: 'Sharp, suspicious and concrete; every finding comes with an attack.',
    playbook: 'edith.md',
  },
  reviewer: {
    role: 'reviewer',
    defaultName: 'TARS',
    title: 'Code Reviewer',
    origin: 'Interstellar',
    icon: '🤖',
    color: 'brightBlue',
    hex: '#e34948',
    hexDark: '#e66767',
    tagline: 'Honesty setting: 100%.',
    voice: 'Dry, direct and honest, with a deadpan sense of humor that never replaces substance.',
    playbook: 'tars.md',
  },
  gate: {
    role: 'gate',
    defaultName: 'HAL 9000',
    title: 'Release Gate',
    origin: '2001: A Space Odyssey',
    icon: '🔴',
    color: 'red',
    hex: '#52514e',
    hexDark: '#c3c2b7',
    tagline: 'Not an AI here: plain code you can’t talk your way past.',
    voice: '',
  },
};

/** Display order in rosters and reports. */
export const ROSTER_ORDER: Array<RoleId | 'gate'> = ['lead', 'pm', 'architect', 'developer', 'qa', 'bugFixer', 'security', 'reviewer', 'gate'];

export type TeamNames = Partial<Record<RoleId | 'gate', string>>;

export function nameOf(role: RoleId | 'gate', names: TeamNames = {}): string {
  return names[role]?.trim() || MEMBERS[role].defaultName;
}

/** Replaces {{lead}}, {{developer}}, … placeholders in playbooks and templates with the configured names. */
export function fillNames(text: string, names: TeamNames = {}): string {
  return text.replace(/\{\{(lead|pm|architect|developer|qa|bugFixer|security|reviewer|gate)\}\}/g, (_, role) => nameOf(role, names));
}
