
import { hasServerRestarted } from './eventsGeneration'
import type { WindowBehaviorSnapshot } from '../../shared/windowBehavior.js'

export interface CoreEventsConsumerHandlers {
  converge: () => void
  onPresetSwitched: () => void
  onWindowBehaviorChanged: (snapshot: WindowBehaviorSnapshot) => void
  log: {
    generationChanged: () => void
    helloHeartbeatParseError: (err: unknown) => void
    windowBehaviorParseError: (err: unknown) => void
  }
}

export interface CoreEventsConsumer {
  onConnected: () => void
  onChunk: (text: string) => void
}

export function createCoreEventsConsumer(handlers: CoreEventsConsumerHandlers): CoreEventsConsumer {
  let buffer = ''
  let lastSeenCoreGeneration: string | null = null

  function dispatchFrame(frame: string): void {
    const lines = frame.split('\n')
    if (lines.some(line => line === 'event: hello' || line === 'event: heartbeat')) {
      const dataLine = lines.find(line => line.startsWith('data: '))
      if (dataLine) {
        try {
          const { generation } = JSON.parse(dataLine.slice('data: '.length)) as { generation: string }
          if (hasServerRestarted(lastSeenCoreGeneration, generation)) {
            handlers.log.generationChanged()
          }
          lastSeenCoreGeneration = generation
        } catch (err) {
          handlers.log.helloHeartbeatParseError(err)
        }
      }
    }
    if (lines.some(line => line === 'event: preset-switched')) {
      handlers.onPresetSwitched()
    }
    if (lines.some(line => line === 'event: window-behavior-changed')) {
      const dataLine = lines.find(line => line.startsWith('data: '))
      if (dataLine) {
        try {
          handlers.onWindowBehaviorChanged(JSON.parse(dataLine.slice('data: '.length)) as WindowBehaviorSnapshot)
        } catch (err) {
          handlers.log.windowBehaviorParseError(err)
        }
      }
    }
  }

  return {
    onConnected(): void {
      buffer = ''
      handlers.converge()
    },
    onChunk(text: string): void {
      buffer += text
      let frameEnd = buffer.indexOf('\n\n')
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        dispatchFrame(frame)
        frameEnd = buffer.indexOf('\n\n')
      }
    }
  }
}
