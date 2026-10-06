import { synthesize, type SoundCue } from '@shared/sounds'

// Plays the cues from @shared/sounds through Web Audio. A sound is a nicety:
// with no audio device, or anything else going wrong, Suri stays quiet.

let context: AudioContext | null = null
const buffers = new Map<SoundCue, AudioBuffer>()

export function playCue(cue: SoundCue): void {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    let buffer = buffers.get(cue)
    if (!buffer) {
      const samples = synthesize(cue, context.sampleRate)
      buffer = context.createBuffer(1, samples.length, context.sampleRate)
      buffer.copyToChannel(samples, 0)
      buffers.set(cue, buffer)
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start()
  } catch {
    // Silence is the fallback.
  }
}
