import type { UnifiedSong } from '../../types';
import type { ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/ytmusicNormalize.ts
// Bridge DTOs (electron/ytmusic/normalize.cjs) -> Omni types. Identity is the 11-character videoId
// for songs and the browse id for collections; nothing here touches youtubei.js objects.

export interface YtMusicTrackDto {
    videoId: string;
    title: string;
    artists: Array<{ id: string | null; name: string }>;
    album: { id: string; name: string } | null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
    kind: 'song' | 'video';
}

export interface YtMusicCollectionDto {
    id: string;
    kind: 'album' | 'playlist' | 'artist';
    title: string;
    subtitle: string;
    thumbnailUrl: string | null;
}

export interface YtMusicDetailDto {
    id: string;
    title: string;
    subtitle: string;
    description: string;
    thumbnailUrl: string | null;
}

export interface YtMusicAccountDto {
    name: string;
    handle: string;
    avatarUrl: string | null;
}

const LIKED_PLAYLIST_IDS = new Set(['LM', 'VLLM']);

// List rows carry 60px thumbnails; googleusercontent URLs encode their size and serve any size asked for.
export const toYtMusicCoverUrl = (url: string | null | undefined): string => (
    url ? url.replace(/=w\d+-h\d+[^/]*$/, '=w544-h544-l90-rj') : ''
);

export const normalizeYtMusicSong = (raw: unknown): UnifiedSong => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Partial<YtMusicTrackDto> & Partial<UnifiedSong>;
    // Cached canonical songs come back through normalizeSong unchanged.
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === 'ytmusic') return item as UnifiedSong;
    if (typeof item.videoId !== 'string' || !item.videoId) {
        throw new OnlineProviderError('invalid-response', 'YouTube Music track has no video id', 'ytmusic');
    }
    const album = item.album ?? null;
    return {
        id: item.videoId,
        name: item.title || item.videoId,
        artists: (item.artists ?? []).map(artist => ({
            id: artist.id ?? artist.name,
            name: artist.name,
            ...(artist.id ? { catalogRef: { providerId: 'ytmusic', kind: 'artist' as const, id: artist.id } } : {}),
        })),
        album: {
            id: album?.id ?? '',
            name: album?.name ?? '',
            coverUrl: toYtMusicCoverUrl(item.thumbnailUrl),
            ...(album?.id ? { catalogRef: { providerId: 'ytmusic', kind: 'album' as const, id: album.id } } : {}),
        },
        durationMs: Math.max(0, Number(item.durationSeconds) || 0) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'ytmusic',
            mediaId: item.videoId,
            ...(item.kind === 'video' ? { providerData: { kind: 'video' } } : {}),
        },
    };
};

export const normalizeYtMusicCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Partial<YtMusicCollectionDto & YtMusicDetailDto> & Partial<ProviderCollection>;
    if (item.providerId === 'ytmusic') return item as ProviderCollection;
    if (typeof item.id !== 'string' || !item.id) {
        throw new OnlineProviderError('invalid-response', 'YouTube Music collection has no id', 'ytmusic');
    }
    const liked = LIKED_PLAYLIST_IDS.has(item.id);
    return {
        providerId: 'ytmusic',
        id: item.id,
        type: item.kind ?? type,
        name: item.title || item.id,
        coverUrl: toYtMusicCoverUrl(item.thumbnailUrl),
        description: item.description || item.subtitle || '',
        ...(liked ? { isLiked: true, isOwned: true } : {}),
    };
};

export const normalizeYtMusicUser = (raw: unknown): ProviderUser => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Partial<YtMusicAccountDto>;
    return {
        // One signed-in account per app; the handle is stable when YouTube reports one.
        id: item.handle || 'me',
        nickname: item.name || 'YouTube Music',
        avatarUrl: item.avatarUrl ?? '',
    };
};

export const ytMusicPage = <T>(items: T[], offset: number, hasMore: boolean): ProviderPage<T> => ({
    items,
    hasMore,
    nextOffset: offset + items.length,
});
