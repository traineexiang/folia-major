'use strict';

const { parseRangeHeader } = require('../transcode/protocol.cjs');

// electron/ytmusic/audioProtocol.cjs
// googlevideo answers only bounded byte ranges (an open `bytes=0-`, which every <audio> element sends,
// is a 403), and sends no CORS headers for Web Audio. This scheme serves the media element's Range
// requests by walking the stream in bounded chunks from the main process, and re-resolves the stream
// once when its signed URL has expired. The renderer never sees the googlevideo URL.

const YTMUSIC_AUDIO_SCHEME = 'ytmusic-audio';
const CHUNK_BYTES = 1024 * 1024;
const VIDEO_ID = /^[\w-]{11}$/;

const parseYtMusicAudioUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== `${YTMUSIC_AUDIO_SCHEME}:` || url.hostname !== 'media') return null;
    const id = url.pathname.replace(/^\//, '');
    return VIDEO_ID.test(id) ? id : null;
  } catch { return null; }
};

const toYtMusicAudioUrl = videoId => `${YTMUSIC_AUDIO_SCHEME}://media/${videoId}`;

// resolveStream(videoId, { refresh }) -> { url, contentLength, mimeType }
const createProtocolResponse = async (request, { resolveStream, fetchImpl = fetch }) => {
  const videoId = parseYtMusicAudioUrl(request.url);
  if (!videoId) return new Response('Not found', { status: 404 });
  let stream;
  try { stream = await resolveStream(videoId, { refresh: false }); } catch { stream = null; }
  if (!stream?.url || !Number.isSafeInteger(stream.contentLength)) return new Response('Not found', { status: 404 });

  const size = stream.contentLength;
  const range = parseRangeHeader(request.headers.get('range'), size);
  if (range?.invalid) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': stream.mimeType.split(';')[0],
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const abort = new AbortController();
  let offset = start;
  let refreshed = false;
  const fetchChunk = async () => {
    const chunkEnd = Math.min(offset + CHUNK_BYTES - 1, end);
    let response = await fetchImpl(stream.url, { headers: { Range: `bytes=${offset}-${chunkEnd}` }, signal: abort.signal });
    if (response.status === 403 && !refreshed) {
      refreshed = true; // signed URL expired mid-playback
      stream = await resolveStream(videoId, { refresh: true });
      response = await fetchImpl(stream.url, { headers: { Range: `bytes=${offset}-${chunkEnd}` }, signal: abort.signal });
    }
    if (response.status !== 206 && response.status !== 200) throw new Error(`Upstream ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const body = new ReadableStream({
    async pull(controller) {
      if (offset > end) { controller.close(); return; }
      try {
        const bytes = await fetchChunk();
        if (bytes.byteLength === 0) { controller.close(); return; }
        offset += bytes.byteLength;
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { abort.abort(); },
  });
  return new Response(body, { status, headers });
};

const registerYtMusicAudioProtocol = ({ protocol, resolveStream }) => {
  protocol.handle(YTMUSIC_AUDIO_SCHEME, request => createProtocolResponse(request, { resolveStream }));
};

module.exports = {
  YTMUSIC_AUDIO_SCHEME,
  createProtocolResponse,
  parseYtMusicAudioUrl,
  registerYtMusicAudioProtocol,
  toYtMusicAudioUrl,
};
