// The glass as a mirror: the visitor's camera, asked for only when they switch the set off (tv.tsx), and shown only as a
// dim reflection in the dark tube (tv.tsx's shader, uMirror). The stream goes to one <video> element that is never put
// in the page, and from it only into the tube's WebGL texture (texImage2D). Nothing reads a frame back (no 2D canvas,
// getImageData, readPixels, toDataURL or toBlob), stores one, or sends one anywhere. stop() ends every track, which
// switches the camera (and its light) off; tv.tsx calls it the moment the set comes on, the tab is hidden or the page
// goes. This module loads only once the visitor has switched the set off and the browser hasn't refused the camera.

export type Mirror = { video: HTMLVideoElement; stop: () => void }

/** Asks for the front camera, small and slow (the reflection is dim and soft), by its height alone, so it keeps its own
 *  shape (a phone's, upright, is taller than wide): null where there is no camera to ask for; it throws if the visitor
 *  says no. */
export async function openMirror(): Promise<Mirror | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } } })
  const video = document.createElement('video')
  video.muted = true; video.playsInline = true; video.srcObject = stream
  const stop = () => { for (const track of stream.getTracks()) track.stop(); video.pause(); video.srcObject = null }
  try { await video.play() } catch { stop(); return null }
  return { video, stop }
}
