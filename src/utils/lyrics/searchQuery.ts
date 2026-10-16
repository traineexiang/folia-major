// src/utils/lyrics/searchQuery.ts
// Shared helpers for constructing lyric search queries from song metadata.

import { normalizeLyricMatchText } from './matchScore';

const MAX_ALBUM_QUERY_LENGTH = 48;

const normalizeArtistIdentity = (value: string): string => (
    normalizeLyricMatchText(value).replace(/\s+/gu, '')
);

// Removes a duplicated "artist - title" prefix when the provider already supplies artists separately.
export const normalizeSongTitleForLyricSearch = (
    title?: string | null,
    artist?: string | null,
): string => {
    const trimmedTitle = title?.trim() || '';
    const trimmedArtist = artist?.trim() || '';
    if (!trimmedTitle || !trimmedArtist) return trimmedTitle;

    const separator = trimmedTitle.match(/^(.+?)\s+-\s+(.+)$/u);
    if (!separator) return trimmedTitle;

    return normalizeArtistIdentity(separator[1]) === normalizeArtistIdentity(trimmedArtist)
        ? separator[2].trim()
        : trimmedTitle;
};

// YouTube Music appends a Latin translation or romanization to CJK titles ("紅豆 - Red Bean").
// Chinese catalogs list only the original, so the suffix is dropped; Latin-only titles are untouched.
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_ONLY_PATTERN = /^[\p{Script=Latin}\p{N}\s'’.,!?&()\[\]:;\-]+$/u;

export const stripLatinTitleTranslation = (title?: string | null): string => {
    const trimmedTitle = title?.trim() || '';
    const separator = trimmedTitle.match(/^(.+?)\s+-\s+(.+)$/u);
    if (!separator) return trimmedTitle;
    const [, original, suffix] = separator;
    return CJK_PATTERN.test(original) && LATIN_ONLY_PATTERN.test(suffix) && /\p{Script=Latin}/u.test(suffix)
        ? original.trim()
        : trimmedTitle;
};

export const hasCjkText = (value?: string | null): boolean => CJK_PATTERN.test(value || '');

// Keeps long anime/single album names useful for provider search by dropping catalog notes and credits first.
const normalizeAlbumForLyricSearch = (album?: string | null): string | null => {
    const trimmedAlbum = album?.trim();
    if (!trimmedAlbum) {
        return null;
    }

    if (trimmedAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return trimmedAlbum;
    }

    const compactAlbum = trimmedAlbum
        .replace(/\s*※.*$/u, '')
        .replace(/\s*(歌|歌唱|アーティスト|Artist)\s*[:：]?\s*.+$/iu, '')
        .trim();

    if (compactAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return compactAlbum;
    }

    return compactAlbum.slice(0, MAX_ALBUM_QUERY_LENGTH).trim();
};

export const buildLyricSearchQuery = (
    title?: string | null,
    artist?: string | null,
    album?: string | null
): string => {
    return [normalizeSongTitleForLyricSearch(title, artist), artist?.trim(), normalizeAlbumForLyricSearch(album)]
        .map(part => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(' - ');
};

export const buildKugouLyricSearchQuery = (keyword: string): string => {
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) {
        return trimmedKeyword;
    }

    const structuredTitle = trimmedKeyword.split(/\s+-\s+/u)[0]?.trim();
    return structuredTitle || trimmedKeyword;
};
