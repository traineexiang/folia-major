// electron/ytmusic/library.cjs
// Read and write operations on a signed-in Innertube instance, returning bridge DTOs only.
// YouTube pages by continuation token; Omni pages by offset. Each call walks continuations until it
// covers offset + limit, which is stateless and cheap at personal-library sizes.

const { text, toCollection, toTrack } = require('./normalize.cjs');

const MAX_PAGES = 40; // ~4000 rows; guards against a continuation loop

const collectPages = async (first, pick, wanted) => {
  const items = [];
  let page = first;
  for (let index = 0; page && index < MAX_PAGES; index++) {
    items.push(...pick(page));
    if (items.length >= wanted || !page.has_continuation) {
      return { items, hasMore: items.length > wanted || Boolean(page.has_continuation) };
    }
    page = await page.getContinuation();
  }
  return { items, hasMore: false };
};

const sliceTracks = ({ items, hasMore }, offset, limit) => {
  const tracks = items.map(toTrack).filter(Boolean);
  return { tracks: tracks.slice(offset, offset + limit), hasMore: hasMore || tracks.length > offset + limit };
};

const headerOf = (header, id) => {
  const thumbnails = header?.thumbnail?.contents ?? header?.thumbnails ?? [];
  const thumbnail = thumbnails.reduce?.((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), thumbnails[0]);
  return {
    id,
    title: text(header?.title),
    subtitle: text(header?.subtitle),
    description: text(header?.description?.description ?? header?.description),
    thumbnailUrl: thumbnail?.url ?? null,
  };
};

const NETWORK_ERROR = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|network/i;
const signedOut = message => Object.assign(new Error(message), { code: 'auth-required' });

// The account menu is the sign-in check. YouTube answers a dead cookie (signed out, expired, revoked)
// with no error at all, just signed-out pages: the account menu comes back empty or unparseable. So
// anything but a named account is a rejected session; only a network failure stays a network failure.
async function getAccount(yt) {
  let info;
  try {
    info = await yt.account.getInfo();
  } catch (error) {
    if (NETWORK_ERROR.test(String(error?.message ?? ''))) throw error;
    throw signedOut('YouTube Music account menu unavailable; session signed out');
  }
  const item = info?.contents?.contents?.find(entry => entry.account_name);
  if (!item) throw signedOut('YouTube Music account menu has no account; session signed out');
  return {
    name: text(item.account_name),
    handle: text(item.channel_handle),
    avatarUrl: item.account_photo?.[0]?.url ?? null,
  };
}

async function search(yt, { query, limit, offset }) {
  const first = await yt.music.search(query, { type: 'song' });
  const shelf = first.songs;
  if (!shelf) return { tracks: [], hasMore: false };
  const wanted = offset + limit;
  const items = [...(shelf.contents ?? [])];
  let page = first;
  for (let index = 0; items.length < wanted && page.has_continuation && index < MAX_PAGES; index++) {
    page = await page.getContinuation();
    items.push(...(page.contents?.contents ?? []));
  }
  return sliceTracks({ items, hasMore: page.has_continuation }, offset, limit);
}

async function getPlaylistTracks(yt, { id, limit, offset }) {
  const first = await yt.music.getPlaylist(id);
  const result = await collectPages(first, page => (page.items ?? []).filter(item => item.type !== 'ContinuationItem'), offset + limit);
  return {
    ...sliceTracks(result, offset, limit),
    ...(offset === 0 ? { detail: headerOf(first.header, id) } : {}),
  };
}

async function getAlbum(yt, { id }) {
  const album = await yt.music.getAlbum(id);
  const detail = headerOf(album.header, id);
  const tracks = (album.contents ?? []).map(toTrack).filter(Boolean)
    // Album rows omit the cover and album link; every track inherits them from the album header.
    .map(track => ({ ...track, thumbnailUrl: track.thumbnailUrl ?? detail.thumbnailUrl, album: track.album ?? { id, name: detail.title } }));
  return { detail, tracks };
}

async function getLibraryPlaylists(yt) {
  const library = await yt.music.getLibrary();
  const result = await collectPages(library, page => {
    const sections = page.contents ? (Array.isArray(page.contents) ? page.contents : [page.contents]) : [];
    return sections.flatMap(section => section.items ?? section.contents ?? []);
  }, Number.MAX_SAFE_INTEGER);
  return { collections: result.items.map(toCollection).filter(item => item?.kind === 'playlist') };
}

async function getLikedVideoIds(yt) {
  const first = await yt.music.getPlaylist('LM');
  const result = await collectPages(first, page => page.items ?? [], Number.MAX_SAFE_INTEGER);
  return { videoIds: result.items.map(toTrack).filter(Boolean).map(track => track.videoId) };
}

async function getUpNext(yt, { videoId }) {
  const panel = await yt.music.getUpNext(videoId, true);
  return { tracks: (panel.contents ?? []).map(toTrack).filter(Boolean) };
}

const HISTORY_LIMIT = 100;

// The account's YouTube Music history (newest first, grouped by day upstream), each song once.
// youtubei.js has no Music client call for it; the page is a plain browse of MusicShelf rows.
async function getHistory(yt) {
  const page = await yt.actions.execute('/browse', { browseId: 'FEmusic_history', client: 'YTMUSIC', parse: true });
  const seen = new Set();
  const tracks = (page.contents_memo?.get('MusicShelf') ?? [])
    .flatMap(shelf => shelf.contents ?? [])
    .map(toTrack)
    .filter(track => track && !seen.has(track.videoId) && seen.add(track.videoId));
  return { tracks: tracks.slice(0, HISTORY_LIMIT) };
}

async function setLike(yt, { videoId, liked }) {
  if (liked) await yt.interact.like(videoId);
  else await yt.interact.removeRating(videoId);
  return { liked };
}

// Adds the track to the account's YouTube Music history ("Listen again" is built from it).
async function reportPlay(yt, { videoId }) {
  const info = await yt.music.getInfo(videoId);
  await info.addToWatchHistory();
  return { reported: true };
}

module.exports = {
  getAccount,
  getAlbum,
  getHistory,
  getLibraryPlaylists,
  getLikedVideoIds,
  getPlaylistTracks,
  getUpNext,
  reportPlay,
  search,
  setLike,
};
