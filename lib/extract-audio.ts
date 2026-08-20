// Pull just the audio track out of a local video, in the browser.
//
// The Upload & Process panel needs captions for a file that never leaves the
// device. Sending the whole video to the server would mean a multi-hundred-MB
// upload over a slow link; the audio alone is ~1 MB per minute, so a 10-minute
// clip becomes a ~10 MB post instead of a 400 MB one.
//
// Packets are remuxed, never re-encoded — no decoding cost, no quality loss.
// The container is chosen to match the codec (AAC → MP4, Opus/Vorbis → WebM),
// because Opus inside MP4 is not something Whisper reliably accepts.

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  EncodedPacketSink,
  EncodedAudioPacketSource,
} from 'mediabunny'

export interface ExtractedAudio {
  blob: Blob
  fileName: string
  durationSeconds: number
}

export async function extractAudioTrack(video: Blob): Promise<ExtractedAudio> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) })

  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This file has no audio track, so it cannot be transcribed.')

    const codec = track.codec
    if (!codec) throw new Error('Could not identify the audio codec in this file.')

    const decoderConfig = await track.getDecoderConfig()
    if (!decoderConfig) throw new Error('Could not read the audio configuration in this file.')

    const duration = await track.computeDuration()

    // Opus/Vorbis belong in WebM; AAC and friends go in MP4.
    const useWebM = /opus|vorbis/i.test(codec)
    const output = new Output({
      format: useWebM ? new WebMOutputFormat() : new Mp4OutputFormat(),
      target: new BufferTarget(),
    })

    const source = new EncodedAudioPacketSource(codec)
    output.addAudioTrack(source)
    await output.start()

    const sink = new EncodedPacketSink(track)
    let first = true
    try {
      for await (const packet of sink.packets()) {
        // Negative timestamps (container edit lists) are rejected by the
        // muxer — same guard the video pipeline uses.
        const ts = (packet as { microsecondTimestamp?: number }).microsecondTimestamp ?? 0
        if (ts < 0) continue
        if (first) {
          await source.add(packet, { decoderConfig })
          first = false
        } else {
          await source.add(packet)
        }
      }
    } finally {
      source.close()
    }

    await output.finalize()
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer || buffer.byteLength < 512) {
      throw new Error('Audio extraction produced an empty file.')
    }

    return {
      blob: new Blob([buffer], { type: useWebM ? 'audio/webm' : 'audio/mp4' }),
      fileName: useWebM ? 'audio.webm' : 'audio.m4a',
      durationSeconds: duration,
    }
  } finally {
    input.dispose()
  }
}
