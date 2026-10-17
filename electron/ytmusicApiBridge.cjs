const { createYtMusicSessionRepository, isUsableCookie } = require('./ytmusic/session.cjs');
const library = require('./ytmusic/library.cjs');
const { toYtMusicAudioUrl } = require('./ytmusic/audioProtocol.cjs');

// electron/ytmusicApiBridge.cjs
// YouTube Music through youtubei.js (unofficial InnerTube client, personal use). The cookie stays in
// this process; the renderer gets plain DTOs and `ytmusic-audio://` URLs (see ytmusic/audioProtocol.cjs). youtubei.js breaks whenever YouTube
// changes its player or responses, so parser/decipher failures surface as `update-needed`, distinct
// from `auth-required`, and the fix is `npm run ytmusic:update`.

// Sign-in is a pasted cookie header: Google refuses sign-in inside an embedded Electron window
// ("This browser or app may not be secure"), even with Chrome's user agent and client hints.
const OPERATIONS = ['status', 'login_cookie', 'logout', 'account', 'audio', 'history', 'search', 'playlist',
  'album', 'library_playlists', 'liked_ids', 'up_next', 'like', 'report_play'];
const VIDEO_ID = /^[\w-]{11}$/;
// Playlist ids (PL…, VL…, RD…, LM, OLAK…) and album browse ids (MPRE…); never a URL or path.
const BROWSE_ID = /^[\w-]{2,64}$/;
const MAX_PAGE = 200;
// web_music plays full tracks with a signed-in cookie (no PO token observed); android_vr is the
// anonymous fallback, which YouTube cuts off after roughly a minute without a PO token.
const STREAM_CLIENTS = ['YTMUSIC', 'ANDROID_VR'];

// youtubei.js >=16 leaves JS evaluation to the host; the player script runs only in this process.
const evaluatePlayerScript = (data, env) => {
  const exports = [];
  if (env.n) exports.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) exports.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return new Function(`${data.output}\nreturn { ${exports.join(', ')} }`)();
};

const invalid = message => Object.assign(new Error(message), { code: 'invalid-params' });
const videoIdOf = params => {
  const id = String(params?.videoId ?? '');
  if (!VIDEO_ID.test(id)) throw invalid('Invalid video id');
  return id;
};
const browseIdOf = params => {
  const id = String(params?.id ?? '');
  if (!BROWSE_ID.test(id)) throw invalid('Invalid browse id');
  return id;
};
const pageOf = params => {
  const limit = Number(params?.limit ?? 50);
  const offset = Number(params?.offset ?? 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || limit < 1 || offset < 0) throw invalid('Invalid page');
  return { limit: Math.min(limit, MAX_PAGE), offset };
};

const failure = (code, message) => ({ ok: false, error: { code, message } });

const classifyError = error => {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (/ParsingError|decipher|PlayerError|InnertubeError/i.test(`${name} ${message}`)) {
    return failure('update-needed', 'YouTube Music changed; update youtubei.js');
  }
  if (/status code (401|403)/.test(message)) return failure('auth-required', 'YouTube Music session was rejected');
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|network/i.test(message)) return failure('network', 'YouTube Music could not be reached');
  return failure('invalid-response', 'YouTube Music request failed');
};

const MAX_STREAMS = 64;
// Refresh a little before the signed URL's own expiry so a long track never starts on a dying URL.
const STREAM_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

function createYtMusicApiBridge({ store, safeStorage,
  loadYoutubei = () => import('youtubei.js'), now = Date.now, warn = console.warn }) {
  const sessions = createYtMusicSessionRepository({ store, safeStorage, warn });
  let client = null; // { revision, promise }
  const streams = new Map(); // videoId -> resolved stream (googlevideo URL stays in this process)

  const getClient = () => {
    const revision = sessions.revision;
    if (client?.revision === revision) return client.promise;
    const promise = (async () => {
      const { Innertube, Platform, UniversalCache } = await loadYoutubei();
      Platform.shim.eval = evaluatePlayerScript;
      return Innertube.create({
        cookie: sessions.get()?.cookie,
        cache: new UniversalCache(false),
        retrieve_player: true,
      });
    })();
    client = { revision, promise };
    promise.catch(() => { if (client?.promise === promise) client = null; });
    return promise;
  };

  const requireSignedIn = async () => {
    if (!sessions.get()) throw Object.assign(new Error('Not signed in'), { code: 'auth-required' });
    const yt = await getClient();
    if (!yt.session.logged_in) throw Object.assign(new Error('Session rejected'), { code: 'auth-required' });
    return yt;
  };

  const resolveAudio = async ({ videoId }) => {
    const yt = await getClient();
    let lastError = null;
    for (const clientName of STREAM_CLIENTS) {
      try {
        const info = await yt.getBasicInfo(videoId, { client: clientName });
        if (info.playability_status?.status && info.playability_status.status !== 'OK') {
          lastError = Object.assign(new Error(info.playability_status.reason || 'Unplayable'), { code: 'not-playable' });
          continue;
        }
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });
        const url = await format.decipher(yt.session.player);
        const expire = Number(new URL(url).searchParams.get('expire'));
        return {
          url,
          mimeType: format.mime_type,
          bitrate: format.bitrate ?? null,
          contentLength: format.content_length ?? null,
          durationSeconds: info.basic_info?.duration ?? null,
          expiresAt: Number.isFinite(expire) && expire > 0 ? expire * 1000 : now() + 5 * 60 * 60 * 1000,
          client: clientName,
          // Without a cookie YouTube serves only the first minute or so; callers treat it as a preview.
          preview: clientName !== 'YTMUSIC' || !yt.session.logged_in,
        };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No playable audio format');
  };

  const resolveStream = async (videoId, { refresh = false } = {}) => {
    const cached = streams.get(videoId);
    if (!refresh && cached && cached.expiresAt - STREAM_EXPIRY_MARGIN_MS > now()) return cached;
    const stream = await resolveAudio({ videoId });
    streams.delete(videoId);
    streams.set(videoId, stream);
    while (streams.size > MAX_STREAMS) streams.delete(streams.keys().next().value);
    return stream;
  };

  // youtubei.js counts any cookie as signed in; only YouTube can say whether it still is, so the account
  // is read before the cookie is kept. A refused cookie (401/403) is classified as auth-required.
  const signIn = async cookie => {
    sessions.set(cookie);
    streams.clear();
    try {
      const yt = await getClient();
      if (!yt.session.logged_in) throw Object.assign(new Error('Session rejected'), { code: 'auth-required' });
      await library.getAccount(yt);
    } catch (error) {
      sessions.clear();
      throw error;
    }
    return { signedIn: true };
  };

  const handlers = {
    async status() {
      const signedIn = Boolean(sessions.get());
      return { signedIn, encryptionAvailable: Boolean(safeStorage?.isEncryptionAvailable?.()) };
    },
    async login_cookie(params) {
      // Accept a copied `cookie:` header line as well as the bare value.
      const cookie = String(params?.cookie ?? '').trim().replace(/^cookie:\s*/i, '');
      if (!isUsableCookie(cookie)) throw Object.assign(new Error('Cookie is missing sign-in values'), { code: 'invalid-params' });
      return signIn(cookie);
    },
    async logout() {
      sessions.clear();
      streams.clear();
      return { signedIn: false };
    },
    async audio(params) {
      const videoId = videoIdOf(params);
      const { url: _upstream, ...stream } = await resolveStream(videoId, { refresh: Boolean(params.refresh) });
      return { ...stream, url: toYtMusicAudioUrl(videoId) };
    },
    account: async () => library.getAccount(await requireSignedIn()),
    history: async () => library.getHistory(await requireSignedIn()),
    async search(params) {
      const query = String(params?.query ?? '').trim().slice(0, 200);
      if (!query) return { tracks: [], hasMore: false };
      return library.search(await getClient(), { query, ...pageOf(params) });
    },
    playlist: async params => library.getPlaylistTracks(await requireSignedIn(), { id: browseIdOf(params), ...pageOf(params) }),
    album: async params => library.getAlbum(await getClient(), { id: browseIdOf(params) }),
    library_playlists: async () => library.getLibraryPlaylists(await requireSignedIn()),
    liked_ids: async () => library.getLikedVideoIds(await requireSignedIn()),
    up_next: async params => library.getUpNext(await getClient(), { videoId: videoIdOf(params) }),
    like: async params => library.setLike(await requireSignedIn(), { videoId: videoIdOf(params), liked: params?.liked === true }),
    report_play: async params => library.reportPlay(await requireSignedIn(), { videoId: videoIdOf(params) }),
  };

  return {
    resolveStream,
    async request(operation, params = {}) {
      if (!OPERATIONS.includes(operation)) return failure('unsupported', 'Unsupported YouTube Music operation');
      try {
        return { ok: true, data: await handlers[operation](params) };
      } catch (error) {
        if (['auth-required', 'not-playable', 'invalid-params'].includes(error?.code)) {
          return failure(error.code, error.code === 'not-playable' ? 'This track is not playable' : 'YouTube Music request rejected');
        }
        return classifyError(error);
      }
    },
  };
}

module.exports = { createYtMusicApiBridge, YTMUSIC_OPERATIONS: OPERATIONS };
