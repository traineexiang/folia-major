// electron/ytmusic/library.cjs
// Read and write operations on a signed-in Innertube instance, returning bridge DTOs only.
// YouTube pages by continuation token; Omni pages by offset. Each call walks continuations until it
// covers offset + limit, which is stateless and cheap at personal-library sizes.

const { text, toCollection, toShelves, toTrack } = require('./normalize.cjs');

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

async function getAccount(yt) {
  try {
    const info = await yt.account.getInfo();
    const item = info.contents?.contents?.find(entry => entry.account_name);
    if (item) {
      return {
        name: text(item.account_name),
        handle: text(item.channel_handle),
        avatarUrl: item.account_photo?.[0]?.url ?? null,
      };
    }
  } catch (error) {
    // A rejected session must surface as auth-required (the bridge maps 401/403); anything else only
    // costs the account name, since a signed-in session is what matters.
    if (/status code (401|403)/.test(String(error?.message ?? ''))) throw error;
  }
  return { name: 'YouTube Music', handle: '', avatarUrl: null };
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

async function getHome(yt) {
  const feed = await yt.music.getHomeFeed();
  return { shelves: toShelves(feed.sections) };
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
  getHome,
  getLibraryPlaylists,
  getLikedVideoIds,
  getPlaylistTracks,
  getUpNext,
  reportPlay,
  search,
  setLike,
};
