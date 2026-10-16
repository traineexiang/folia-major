import type { SongResult } from '../types';
import { getProviderSongMetadata } from './onlineMusic/songMetadata';
import { omni } from './onlineMusic/omni';
import { getFromCache, saveToCache } from './db';
import { normalizeLyricMatchText } from '../utils/lyrics/matchScore';
import { hasCjkText, stripLatinTitleTranslation } from '../utils/lyrics/searchQuery';

// src/services/lyricSearchIdentity.ts
// What to search the lyric catalogs for. A provider with lyrics of its own (NetEase, QQ, KuGou…) is
// searched as it names the song. A provider without (YouTube Music) names Chinese songs for a global
// audience — "三人遊 - Three Tour" by "Khalil Fong" — which no Chinese catalog lists. Explicitly
// cross-provider: the Chinese artist name is looked up once through NetEase search and remembered.

export interface LyricSearchIdentity {
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
}

const ALIAS_CACHE_PREFIX = 'lyric_artist_alias_v1:';
const DURATION_TOLERANCE_MS = 3000;
const aliasMemory = new Map<string, string>();
// Songs whose lookup proved nothing; another song by the same artist may still prove the alias.
const missedSongs = new Set<string>();

// Script- and punctuation-normalized, without spaces: "愛, 很簡單" and "爱，很简单" are the same title.
const titleIdentity = (value: string) => normalizeLyricMatchText(value).replace(/\s+/gu, '');

const aliasKey = (artist: string) => `${ALIAS_CACHE_PREFIX}${artist.trim().toLowerCase()}`;

/**
 * The Chinese name NetEase gives this artist, proven by one song: the top results must contain the
 * same title (script-normalized) within 3 s of the same length. A proven alias is stored per artist;
 * a miss is remembered per song for this run only, so it never blocks the artist's other songs.
 */
export async function resolveCjkArtistAlias(artist: string, title: string, durationMs: number): Promise<string | null> {
    const key = aliasKey(artist);
    const memorized = aliasMemory.get(key);
    if (memorized) return memorized;
    const songKey = `${key}|${titleIdentity(title)}`;
    if (missedSongs.has(songKey)) return null;
    const stored = await getFromCache<string>(key).catch(() => null);
    if (stored) {
        aliasMemory.set(key, stored);
        return stored;
    }

    let alias: string | null = null;
    try {
        const page = await omni.searchProviderSongs('netease', `${artist} ${title}`, { limit: 5, offset: 0 });
        const wantedTitle = titleIdentity(title);
        const match = page.items.find(candidate => {
            const metadata = getProviderSongMetadata(candidate);
            return titleIdentity(candidate.name) === wantedTitle
                && (!durationMs || Math.abs(metadata.durationMs - durationMs) <= DURATION_TOLERANCE_MS);
        });
        const names = match ? getProviderSongMetadata(match).artists.map(item => item.name).filter(Boolean) : [];
        alias = names.length > 0 && names.some(hasCjkText) ? names.join(', ') : null;
    } catch (error) {
        // NetEase unreachable: search with the original name now, ask again on the next song.
        console.warn('[LyricSearchIdentity] NetEase artist lookup failed', error);
        return null;
    }

    if (!alias) {
        missedSongs.add(songKey);
        return null;
    }
    aliasMemory.set(key, alias);
    await saveToCache(key, alias).catch(() => {});
    return alias;
}

export async function resolveLyricSearchIdentity(song: SongResult): Promise<LyricSearchIdentity> {
    const metadata = getProviderSongMetadata(song);
    const artist = metadata.artists.map(item => item.name).join(', ');
    if (omni.canGetLyrics(song)) {
        return { title: song.name, artist, album: metadata.album?.name, durationMs: metadata.durationMs };
    }

    // No album: it often names a compilation the other catalogs do not list, and an album miss caps
    // the match score below the threshold.
    const title = stripLatinTitleTranslation(song.name);
    const needsAlias = Boolean(artist) && !hasCjkText(artist) && hasCjkText(title);
    const alias = needsAlias ? await resolveCjkArtistAlias(artist, title, metadata.durationMs) : null;
    return { title, artist: alias ?? artist, durationMs: metadata.durationMs };
}

export const resetLyricSearchIdentityMemory = () => {
    aliasMemory.clear();
    missedSongs.clear();
};
