import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/ytmusicProvider.test.ts — DTO normalization, error mapping and Omni routing.

const request = vi.hoisted(() => vi.fn());
vi.mock('@/services/onlineMusic/ytmusicTransport', async importOriginal => ({
    ...(await importOriginal<typeof import('@/services/onlineMusic/ytmusicTransport')>()),
    requestYtMusic: request,
    getYtMusicTransportAvailability: () => ({ configured: true }),
}));
import { ytmusicProvider } from '@/services/onlineMusic/ytmusicProvider';
import { normalizeYtMusicCollection, normalizeYtMusicSong, toYtMusicCoverUrl } from '@/services/onlineMusic/ytmusicNormalize';
import { toYtMusicProviderError } from '@/services/onlineMusic/ytmusicTransport';
import { omni } from '@/services/onlineMusic/omni';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';

const track = {
    videoId: 'm9SMT5ipbxk', title: 'アイドル', kind: 'song' as const, durationSeconds: 214,
    artists: [{ id: 'UCI6B8NkZKqlFWoiC_xE-hzA', name: 'YOASOBI' }],
    album: { id: 'MPREb_6h43ySO9duW', name: 'アイドル' },
    thumbnailUrl: 'https://lh3.googleusercontent.com/abc=w60-h60-l90-rj',
};

beforeEach(() => { request.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('YouTube Music normalization', () => {
    it('maps a bridge track to a provider-scoped song identity', () => {
        const song = normalizeYtMusicSong(track);
        expect(song).toMatchObject({
            id: 'm9SMT5ipbxk', name: 'アイドル', durationMs: 214000,
            sourceRef: { kind: 'online', providerId: 'ytmusic', mediaId: 'm9SMT5ipbxk' },
            album: { id: 'MPREb_6h43ySO9duW', catalogRef: { providerId: 'ytmusic', kind: 'album', id: 'MPREb_6h43ySO9duW' } },
        });
        expect(song.artists[0].catalogRef).toEqual({ providerId: 'ytmusic', kind: 'artist', id: 'UCI6B8NkZKqlFWoiC_xE-hzA' });
        expect(getPlaybackSongKey(song)).toContain('ytmusic');
        // A cached canonical song passes through untouched.
        expect(normalizeYtMusicSong(song)).toBe(song);
    });
    it('asks googleusercontent for a large cover', () => {
        expect(toYtMusicCoverUrl(track.thumbnailUrl)).toBe('https://lh3.googleusercontent.com/abc=w544-h544-l90-rj');
        expect(toYtMusicCoverUrl(null)).toBe('');
    });
    it('marks the liked-music playlist', () => {
        expect(normalizeYtMusicCollection({ id: 'VLLM', kind: 'playlist', title: 'Liked music', subtitle: '', thumbnailUrl: null }))
            .toMatchObject({ providerId: 'ytmusic', id: 'VLLM', isLiked: true, isOwned: true });
        expect(normalizeYtMusicCollection({ id: 'VLPL1', kind: 'playlist', title: 'Mine', subtitle: '', thumbnailUrl: null }).isLiked).toBeUndefined();
    });
    it('rejects rows without an id', () => {
        expect(() => normalizeYtMusicSong({ title: 'x' })).toThrow();
    });
});

describe('YouTube Music errors', () => {
    it('keeps update-needed apart from auth and marks it as not transient', () => {
        const error = toYtMusicProviderError({ code: 'update-needed', message: 'changed' });
        expect(error).toMatchObject({ code: 'unavailable', providerId: 'ytmusic', details: { upstreamCode: 'update-needed', transient: false } });
        expect(toYtMusicProviderError({ code: 'auth-required', message: 'x' }).code).toBe('auth-required');
        expect(toYtMusicProviderError({ code: 'weird', message: 'x' }).code).toBe('invalid-response');
    });
});

describe('YouTube Music provider', () => {
    it('refuses a signed-out preview as the full track', async () => {
        request.mockResolvedValue({ url: 'ytmusic-audio://media/m9SMT5ipbxk', expiresAt: 1, preview: true });
        await expect(ytmusicProvider.playback!.getAudioSource(normalizeYtMusicSong(track), 'high'))
            .rejects.toMatchObject({ code: 'preview-only' });
    });
    it('returns the app-scheme URL for a signed-in stream', async () => {
        request.mockResolvedValue({ url: 'ytmusic-audio://media/m9SMT5ipbxk', expiresAt: 123, preview: false });
        const source = await ytmusicProvider.playback!.getAudioSource(normalizeYtMusicSong(track), 'high');
        expect(source).toMatchObject({ url: 'ytmusic-audio://media/m9SMT5ipbxk', expiresAt: 123, quality: 'high' });
        expect(request).toHaveBeenCalledWith('audio', { videoId: 'm9SMT5ipbxk' });
    });
    it('refuses songs from other providers', async () => {
        const foreign = { ...normalizeYtMusicSong(track), sourceRef: { kind: 'online' as const, providerId: 'netease', mediaId: '1' } };
        await expect(ytmusicProvider.playback!.getAudioSource(foreign, 'high')).rejects.toMatchObject({ code: 'unsupported' });
    });
    it('reports signed out without asking for the account', async () => {
        request.mockResolvedValueOnce({ signedIn: false });
        expect(await ytmusicProvider.auth!.getLoginStatus()).toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('seeds radio from recent listening and drops the seed itself', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const next = { ...track, videoId: 'NhRQqeb0mds', title: '春泥' };
        request.mockImplementation(async (operation: string) => {
            if (operation === 'home') return { shelves: [{ title: 'Listen again', items: [{ type: 'track', track }] }] };
            if (operation === 'up_next') return { tracks: [track, next] };
            throw new Error(operation);
        });
        const fm = await ytmusicProvider.recommendations!.getPersonalFm!();
        expect(fm.map(song => song.id)).toEqual(['NhRQqeb0mds']);
        expect(request).toHaveBeenCalledWith('up_next', { videoId: 'm9SMT5ipbxk' });
    });
    it('pages the library playlists by offset', async () => {
        const collections = Array.from({ length: 3 }, (_, index) => ({ id: `VLPL${index}`, kind: 'playlist', title: `P${index}`, subtitle: '', thumbnailUrl: null }));
        request.mockResolvedValue({ collections });
        const page = await ytmusicProvider.library!.getUserPlaylists('me', 2, 0);
        expect(page).toMatchObject({ total: 3, hasMore: true, nextOffset: 2 });
        expect(page.items.map(item => item.id)).toEqual(['VLPL0', 'VLPL1']);
    });
    it('is reachable through Omni by provider id', async () => {
        request.mockResolvedValue({ tracks: [track], hasMore: false });
        const page = await omni.searchProviderSongs('ytmusic', 'yoasobi', { limit: 20, offset: 0 });
        expect(page.items[0]?.sourceRef).toMatchObject({ providerId: 'ytmusic', mediaId: 'm9SMT5ipbxk' });
        expect(request).toHaveBeenCalledWith('search', { query: 'yoasobi', limit: 20, offset: 0 });
    });
});
