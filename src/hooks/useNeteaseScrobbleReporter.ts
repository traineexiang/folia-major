import type { RefObject } from 'react';
import type { SongResult } from '../types';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { getProviderSongMetadata } from '../services/onlineMusic/songMetadata';
import { isNeteaseScrobbleReady } from '../services/onlineMusic/playbackReportGate';
import { omni } from '../services/onlineMusic/omni';
import { usePlaybackScrobbleReporter, type ScrobbleCandidate } from './usePlaybackScrobbleReporter';

// src/hooks/useNeteaseScrobbleReporter.ts
// NetEase listening reports (听歌打卡) through the shared usePlaybackScrobbleReporter. The eligibility
// below refuses anything whose NetEase song id might not name a real track in NetEase's catalogue.

type UseNeteaseScrobbleReporterParams = {
    audioRef: RefObject<HTMLAudioElement | null>;
    currentSong: SongResult | null;
    /** Changes when automix hands playback to the other deck, so the listeners follow it. */
    activeDeck: string;
};

/**
 * The song's identity as NetEase would have to accept it, or null when it cannot be vouched for.
 *
 * Cloud-disk tracks are excluded outright: an unmatched upload carries a cloud id that names no
 * track in NetEase's catalogue, and reporting one is reporting a play of a song that does not exist.
 */
const resolveScrobbleCandidate = (song: SongResult | null): ScrobbleCandidate | null => {
    if (!song) return null;

    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== 'netease' || source.variant === 'cloud') {
        return null;
    }
    if (!/^\d+$/.test(source.mediaId) || Number(source.mediaId) <= 0) return null;
    if (!omni.canReportPlayback(song)) return null;

    return {
        songKey: getPlaybackSongKey(song),
        mediaId: source.mediaId,
        totalSeconds: getProviderSongMetadata(song).durationMs / 1000,
    };
};

export const useNeteaseScrobbleReporter = (params: UseNeteaseScrobbleReporterParams): void => {
    const enabled = useAudioSettingsStore(state => state.neteaseScrobbleEnabled);
    usePlaybackScrobbleReporter({
        ...params,
        enabled,
        isReady: isNeteaseScrobbleReady,
        resolveCandidate: resolveScrobbleCandidate,
    });
};
