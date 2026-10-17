// electron/ytmusic/normalize.cjs
// youtubei.js returns parser class instances; IPC needs plain data. These DTOs are the bridge's wire
// contract — the renderer adapter (ytmusicNormalize.ts) maps them to Omni types, never raw nodes.

const text = value => (value == null ? '' : String(value.toString?.() ?? value)).trim();

const pickThumbnail = node => {
  const list = node?.thumbnail?.contents ?? node?.thumbnails ?? node?.thumbnail ?? [];
  if (!Array.isArray(list) || list.length === 0) return null;
  const best = list.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  return typeof best.url === 'string' ? best.url : null;
};

const toArtists = node => (Array.isArray(node?.artists) ? node.artists : [])
  .map(artist => ({ id: artist.channel_id ?? null, name: text(artist.name) }))
  .filter(artist => artist.name);

// Song-like nodes: MusicResponsiveListItem, MusicTwoRowItem (item_type song/video), PlaylistPanelVideo.
const toTrack = node => {
  const id = node?.video_id ?? node?.id;
  if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;
  const artists = toArtists(node);
  const author = text(node.author);
  return {
    videoId: id,
    title: text(node.title),
    artists: artists.length > 0 ? artists : (author ? [{ id: null, name: author }] : []),
    album: node.album?.id ? { id: node.album.id, name: text(node.album.name) } : null,
    durationSeconds: Number.isFinite(node.duration?.seconds) ? node.duration.seconds : null,
    thumbnailUrl: pickThumbnail(node),
    kind: node.item_type === 'video' ? 'video' : 'song',
  };
};

// Collection-like nodes in shelves: albums, playlists, artists.
const toCollection = node => {
  if (typeof node?.id !== 'string' || !['album', 'playlist', 'artist'].includes(node.item_type)) return null;
  return {
    id: node.id,
    kind: node.item_type,
    title: text(node.title),
    subtitle: text(node.subtitle),
    thumbnailUrl: pickThumbnail(node),
  };
};

module.exports = { toTrack, toCollection, text };
