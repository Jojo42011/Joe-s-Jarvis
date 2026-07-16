import { getSystemState, setSystemState } from '../db/queries';
import { PERSONALITIES, DEFAULT_PERSONALITY, getPersonalityById, Personality } from '../config/personalities';

const KEY = 'arlo_personality';

export function getSelectedPersonality(): Personality {
  let id: string | undefined;
  try { id = getSystemState(KEY); } catch { /* db not ready */ }
  return getPersonalityById(id || DEFAULT_PERSONALITY);
}

export function setSelectedPersonality(id: string): Personality {
  const p = getPersonalityById(id);
  setSystemState(KEY, p.id);
  return p;
}

export function listPersonalities() {
  const current = getSelectedPersonality().id;
  return {
    current,
    personalities: PERSONALITIES.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb })),
  };
}
