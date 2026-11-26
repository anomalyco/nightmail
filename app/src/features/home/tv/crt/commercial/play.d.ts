/** The commercial, running: its picture is `canvas` (4:3), redrawn by each frame(). */
export type Broadcast = {
  readonly canvas: HTMLCanvasElement
  /** Runs the show on to its clock and draws it `width` px wide. Returns what the show does to the tube it is on:
   *  static (0..1), roll (the picture sliding up through a frame, 0..1) and tilt (radians: the camera knocked). */
  frame: (width: number) => { readonly static: number; readonly roll: number; readonly tilt: number }
  /** Stops the show at once: its sound fades out over a few ms and lets go of the speaker; the GPU device is destroyed. */
  stop: () => void
}

/** Loads and readies the commercial. Resolves when its first frame can be shown; rejects without WebGPU, when
 *  something it needs fails to load, or when `signal` aborts first. sound: where its sound goes (null: silent). */
export function start(options: { sound: { context: AudioContext; input: AudioNode } | null; signal: AbortSignal; onEnd: () => void }): Promise<Broadcast>
