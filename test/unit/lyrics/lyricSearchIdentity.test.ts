import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/lyrics/lyricSearchIdentity.test.ts — what YouTube Music songs are searched for in the lyric catalogs.

const search = vi.hoisted(() => vi.fn());
const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        searchProviderSongs: search,
        canGetLyrics: (song: { sourceRef?: { providerId?: string } }) => song.sourceRef?.providerId !== 'ytmusic',
    },
}));
vi.mock('@/services/db', () => ({
    getFromCache: async (key: string) => cache.get(key) ?? null,
    saveToCache: async (key: string, value: unknown) => { cache.set(key, value); },
}));
import { resetLyricSearchIdentityMemory, resolveLyricSearchIdentity } from '@/services/lyricSearchIdentity';
import { stripLatinTitleTranslation } from '@/utils/lyrics/searchQuery';
import type { SongResult } from '@/types';

const ytSong = (name: string, artist: string, durationMs = 238000, album = '未來') => ({
    id: 'abcdefghijk', name, durationMs,
    artists: [{ id: 'UC1', name: artist }],
    album: { id: 'MPRE1', name: album },
    sourceRef: { kind: 'online', providerId: 'ytmusic', mediaId: 'abcdefghijk' },
}) as SongResult;
const neteaseSong = (name: string, artist: string, durationMs: number) => ({
    id: 1, name, durationMs, artists: [{ id: 2, name: artist }], album: { id: 3, name: '' },
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
}) as SongResult;

beforeEach(() => {
    search.mockReset();
    cache.clear();
    resetLyricSearchIdentityMemory();
});

describe('stripLatinTitleTranslation', () => {
    it.each([
        ['三人遊 - Three Tour', '三人遊'],
        ['日不落 - Sun Will Never Set', '日不落'],
        ['愛, 很簡單 - I Love You', '愛, 很簡單'],
        ['晴天 - 周杰倫', '晴天 - 周杰倫'],
        ['Love Song - Live', 'Love Song - Live'],
        ['紅豆', '紅豆'],
        ['光年之外 - 2016', '光年之外 - 2016'],
    ])('%s -> %s', (input, expected) => {
        expect(stripLatinTitleTranslation(input)).toBe(expected);
    });
});

describe('resolveLyricSearchIdentity', () => {
    it('leaves songs from providers with their own lyrics as they are', async () => {
        const song = { ...neteaseSong('三人游', '方大同', 238000), album: { id: 3, name: '未来' } };
        expect(await resolveLyricSearchIdentity(song)).toEqual({ title: '三人游', artist: '方大同', album: '未来', durationMs: 238000 });
        expect(search).not.toHaveBeenCalled();
    });
    it('searches under the Chinese title and artist, without the album', async () => {
        search.mockResolvedValue({ items: [neteaseSong('三人游', '方大同', 239500)], hasMore: false, nextOffset: 1 });
        expect(await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong')))
            .toEqual({ title: '三人遊', artist: '方大同', durationMs: 238000 });
        expect(search).toHaveBeenCalledWith('netease', 'Khalil Fong 三人遊', { limit: 5, offset: 0 });
    });
    it('treats titles that differ only in punctuation and spacing as the same song', async () => {
        search.mockResolvedValue({ items: [neteaseSong('爱，很简单', '陶喆', 270000)], hasMore: false, nextOffset: 1 });
        expect((await resolveLyricSearchIdentity(ytSong('愛, 很簡單 - I Love You', 'David Tao', 270000))).artist).toBe('陶喆');
    });
    it('remembers the artist so later songs need no lookup', async () => {
        search.mockResolvedValue({ items: [neteaseSong('三人游', '方大同', 238000)], hasMore: false, nextOffset: 1 });
        await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong'));
        resetLyricSearchIdentityMemory(); // a new app run still has the stored alias
        expect((await resolveLyricSearchIdentity(ytSong('紅豆 - Red Bean', 'Khalil Fong', 237000))).artist).toBe('方大同');
        expect(search).toHaveBeenCalledTimes(1);
    });
    it('keeps the original artist when the length or title does not agree', async () => {
        search.mockResolvedValue({ items: [neteaseSong('三人游', '方大同', 260000), neteaseSong('别的歌', '方大同', 238000)], hasMore: false, nextOffset: 2 });
        expect((await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong'))).artist).toBe('Khalil Fong');
        expect(cache.size).toBe(0);
    });
    it('still tries the artist\'s other songs after one lookup proved nothing', async () => {
        search.mockResolvedValueOnce({ items: [], hasMore: false, nextOffset: 0 })
            .mockResolvedValueOnce({ items: [neteaseSong('红豆', '方大同', 237000)], hasMore: false, nextOffset: 1 });
        expect((await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong'))).artist).toBe('Khalil Fong');
        expect((await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong'))).artist).toBe('Khalil Fong');
        expect((await resolveLyricSearchIdentity(ytSong('紅豆 - Red Bean', 'Khalil Fong', 237000))).artist).toBe('方大同');
        expect(search).toHaveBeenCalledTimes(2);
    });
    it('does not look up artists already written in Chinese, or Latin-only songs', async () => {
        await resolveLyricSearchIdentity(ytSong('稻香', '周杰倫'));
        await resolveLyricSearchIdentity(ytSong('Shape of You', 'Ed Sheeran'));
        expect(search).not.toHaveBeenCalled();
    });
    it('falls back to the original artist when NetEase is unreachable', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        search.mockRejectedValue(new Error('offline'));
        expect((await resolveLyricSearchIdentity(ytSong('三人遊 - Three Tour', 'Khalil Fong'))).artist).toBe('Khalil Fong');
    });
});
