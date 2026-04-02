// ─── Faction management ─────────────────────────────────────────
// Central module that tracks which faction the local player controls.
// All systems use these functions instead of hardcoding FACTION_PLAYER/FACTION_ENEMY.
// Team swap simply flips the variable — no entity changes needed.

import { FACTION_PLAYER, FACTION_ENEMY } from './config'

let localFaction = FACTION_PLAYER

/** Which faction the human player controls */
export function getPlayerFaction(): number { return localFaction }

/** Which faction the AI controls */
export function getAIFaction(): number { return localFaction === FACTION_PLAYER ? FACTION_ENEMY : FACTION_PLAYER }

/** Set the local player's faction (used by multiplayer) */
export function setPlayerFaction(faction: number) { localFaction = faction }

/** Swap which faction the human controls (debug team swap) */
export function swapPlayerFaction() {
  localFaction = localFaction === FACTION_PLAYER ? FACTION_ENEMY : FACTION_PLAYER
}
