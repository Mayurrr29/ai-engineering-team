import type { ReleaseDecision } from '../release.js';
import type { RunState } from '../state.js';
import type { Actor, RoleId } from '../team.js';

export type MemberStatus = 'idle' | 'queued' | 'working' | 'done' | 'failed' | 'skipped' | 'oncall' | 'waiting';
export type LogKind = 'info' | 'ok' | 'warn' | 'fail' | 'event';

/** What the orchestrator tells the human while a mission runs. */
export interface TeamUI {
  start(state: RunState): void;
  /** The lineup or mission header changed. */
  update(state: RunState): void;
  member(role: RoleId | 'gate', status: MemberStatus, detail?: string): void;
  activity(role: RoleId, line: string): void;
  log(kind: LogKind, text: string, actor?: Actor): void;
  /** Pause live rendering (e.g. while asking the human a question). */
  suspend(): void;
  resume(): void;
  finish(state: RunState, decision?: ReleaseDecision, reportPath?: string): void;
}

export const silentUI: TeamUI = {
  start() {},
  update() {},
  member() {},
  activity() {},
  log() {},
  suspend() {},
  resume() {},
  finish() {},
};
