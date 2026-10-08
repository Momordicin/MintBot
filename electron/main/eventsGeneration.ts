
import { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS } from '../../shared/eventsLiveness.js'

export { HEARTBEAT_INTERVAL_MS, EVENTS_CLIENT_TIMEOUT_MS }

export function hasServerRestarted(lastSeenGeneration: string | null, incomingGeneration: string): boolean {
  return lastSeenGeneration !== null && lastSeenGeneration !== incomingGeneration
}
