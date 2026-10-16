import type { UnifiedSong } from '../../types';
import type { OnlineMusicProvider, ProviderAudioSource } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { getYtMusicTransportAvailability, requestYtMusic } from './ytmusicTransport';
import {
    normalizeYtMusicCollection,
    normalizeYtMusicSong,
    normalizeYtMusicUser,
    ytMusicPage,
    type YtMusicAccountDto,
    type YtMusicCollectionDto,
    type YtMusicDetailDto,
    type YtMusicShelfItemDto,
    type YtMusicTrackDto,
} from './ytmusicNormalize';

// src/services/onlineMusic/ytmusicProvider.ts
// YouTube Music adapter, desktop only. Unofficial (youtubei.js in the main process), signed in with a
// pasted cookie. Lyrics are left to Folia's lyric matching.

type TrackPage = { tracks: YtMusicTrackDto[]; hasMore: boolean; detail?: YtMusicDetailDto };
type HomeFeed = { shelves: Array<{ title: string; items: YtMusicShelfItemDto[] }> };

const videoIdOf = (song: { sourceRef?: UnifiedSong['sourceRef'] }): string => {
    const source = song.sourceRef;
    if (source?.kind !== 'online' || source.providerId !== 'ytmusic') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to YouTube Music', 'ytmusic');
    }
    return source.mediaId;
};

const toSongs = (tracks: YtMusicTrackDto[]) => tracks.map(normalizeYtMusicSong);

// The "Listen again" shelf is the account's own recent listening; it seeds radio when nothing plays.
export const getYtMusicRecentTracks = async (): Promise<YtMusicTrackDto[]> => {
    const { shelves } = await requestYtMusic<HomeFeed>('home');
    return shelves.flatMap(shelf => shelf.items)
        .flatMap(item => (item.type === 'track' ? [item.track] : []));
};

export const ytmusicProvider: OnlineMusicProvider = {
    id: 'ytmusic',
    displayName: 'YouTube Music',
    shortName: 'YT Music',
    getAvailability: getYtMusicTransportAvailability,
    capabilities: {
        search: true, playback: true, lyrics: false, wordByWordLyrics: false, auth: true,
        userLibrary: true, playlists: true, albums: true, artists: false, recommendations: true,
        mutations: true, likes: true, playbackReports: true,
    },
    normalizeSong: normalizeYtMusicSong,
    normalizeUser: normalizeYtMusicUser,
    normalizeCollection: normalizeYtMusicCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    getSongPageUrl: song => `https://music.youtube.com/watch?v=${encodeURIComponent(videoIdOf(song))}`,
    search: {
        async searchSongs(query, limit, offset) {
            const page = await requestYtMusic<TrackPage>('search', { query, limit, offset });
            return ytMusicPage(toSongs(page.tracks), offset, page.hasMore);
        },
    },
    playback: {
        // YouTube has no cheap single-track lookup; callers already hold the song from a list.
        async getSongDetail() { return null; },
        async getAudioSource(song, quality) {
            const audio = await requestYtMusic<{ url: string; expiresAt: number; preview: boolean }>('audio', { videoId: videoIdOf(song) });
            // Signed out, YouTube serves about a minute; never let caches or timing treat that as the track.
            if (audio.preview) {
                throw new OnlineProviderError('preview-only', 'YouTube Music only offers a preview; sign in again', 'ytmusic',
                    undefined, undefined, undefined, { signInMayHelp: true });
            }
            const source: ProviderAudioSource = { url: audio.url, fetchedAt: Date.now(), expiresAt: audio.expiresAt, quality };
            return source;
        },
    },
    playbackReports: {
        async reportPlayback(song) {
            await requestYtMusic('report_play', { videoId: videoIdOf(song) });
        },
    },
    auth: {
        async getLoginStatus() {
            const status = await requestYtMusic<{ signedIn: boolean }>('status');
            if (!status.signedIn) return null;
            return normalizeYtMusicUser(await requestYtMusic<YtMusicAccountDto>('account'));
        },
        async logout() { await requestYtMusic('logout'); },
        async loginWithCookie(cookie) {
            try {
                await requestYtMusic('login_cookie', { cookie });
            } catch (error) {
                // The bridge refuses a cookie without SAPISID / __Secure-3PSID before asking YouTube.
                if (error instanceof OnlineProviderError && error.details?.upstreamCode === 'invalid-params') {
                    throw new OnlineProviderError('invalid-response', 'Cookie is missing the YouTube sign-in values', 'ytmusic',
                        undefined, undefined, undefined, { stage: 'cookie-format', transient: false });
                }
                throw error;
            }
        },
    },
    library: {
        async getUserPlaylists(_userId, limit, offset) {
            const { collections } = await requestYtMusic<{ collections: YtMusicCollectionDto[] }>('library_playlists');
            const items = collections.map(item => normalizeYtMusicCollection(item));
            return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit, hasMore: offset + limit < items.length };
        },
        async getLikedSongIds() {
            return (await requestYtMusic<{ videoIds: string[] }>('liked_ids')).videoIds;
        },
    },
    catalog: {
        canResolveSongCatalogRefs: song => song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'ytmusic',
        resolveSongCatalogRefs: async song => song,
        async getPlaylistTracks(id, limit, offset) {
            const page = await requestYtMusic<TrackPage>('playlist', { id: String(id), limit, offset });
            return ytMusicPage(toSongs(page.tracks), offset, page.hasMore);
        },
        async getPlaylistDetail(id) {
            const page = await requestYtMusic<TrackPage>('playlist', { id: String(id), limit: 1, offset: 0 });
            return page.detail ? normalizeYtMusicCollection(page.detail, 'playlist') : null;
        },
        async getAlbumTracks(id, limit = 50, offset = 0) {
            const album = await requestYtMusic<{ tracks: YtMusicTrackDto[] }>('album', { id: String(id) });
            const tracks = album.tracks.slice(offset, offset + limit);
            return { ...ytMusicPage(toSongs(tracks), offset, offset + limit < album.tracks.length), total: album.tracks.length };
        },
        async getAlbumDetail(id) {
            const album = await requestYtMusic<{ detail: YtMusicDetailDto; tracks: YtMusicTrackDto[] }>('album', { id: String(id) });
            return { ...normalizeYtMusicCollection(album.detail, 'album'), trackCount: album.tracks.length };
        },
    },
    recommendations: {
        // Personal FM is YouTube Music radio seeded from the account's recent listening.
        async getPersonalFm() {
            const recent = await getYtMusicRecentTracks();
            const seed = recent[Math.floor(Math.random() * recent.length)];
            if (!seed) return [];
            const { tracks } = await requestYtMusic<{ tracks: YtMusicTrackDto[] }>('up_next', { videoId: seed.videoId });
            return toSongs(tracks.filter(track => track.videoId !== seed.videoId));
        },
    },
    mutations: {
        async likeSong(song, liked) {
            const videoId = typeof song === 'object' ? videoIdOf(song) : String(song);
            await requestYtMusic('like', { videoId, liked });
        },
    },
};
