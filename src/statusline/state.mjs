import { currentProcess, sameProcess } from '../wash/process.mjs';
import { currentWash, saveUsage } from '../wash/session.mjs';
import { readyRecords } from '../wash/store.mjs';
import { readUsage } from './render.mjs';

// What the status line should say about a wash, if anything: a brief being
// written in this session, or one this terminal's next /clear will load.
//
// It also notes the usage reading, which the /wash hook sizes a brief from.
export function washState(payload, { env = process.env, platform = process.platform, now = Date.now(), me } = {}) {
  const sessionId = payload?.session_id;
  if (typeof sessionId === 'string') {
    const { used, size } = readUsage(payload);
    if (used) saveUsage(env, sessionId, { used, size });
    const wash = currentWash(env, sessionId, now);
    if (wash) return { washing: wash.level };
  }
  const self = me ?? currentProcess(env, platform);
  const mine = readyRecords(env, now).find((record) => sameProcess(record.owner, self));
  return mine ? { ready: { level: mine.level, tokens: mine.tokens } } : null;
}
