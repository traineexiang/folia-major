import type { RefObject } from 'react';
import type { SongResult } from '../types';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { getProviderSongMetadata } from '../services/onlineMusic/songMetadata';
import { isYtMusicScrobbleReady } from '../services/onlineMusic/playbackReportGate';
import { omni } from '../services/onlineMusic/omni';
import { usePlaybackScrobbleReporter, type ScrobbleCandidate } from './usePlaybackScrobbleReporter';

// src/hooks/useYtMusicScrobbleReporter.ts
// Adds really played YouTube Music tracks to the account's watch history, which is what keeps
// "Listen again" current while listening happens in Folia. Same tracker and rate gate as NetEase.

type UseYtMusicScrobbleReporterParams = {
    audioRef: RefObject<HTMLAudioElement | null>;
    currentSong: SongResult | null;
    /** Changes when automix hands playback to the other deck, so the listeners follow it. */
    activeDeck: string;
};

const resolveScrobbleCandidate = (song: SongResult | null): ScrobbleCandidate | null => {
    if (!song) return null;
    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== 'ytmusic') return null;
    if (!/^[\w-]{11}$/.test(source.mediaId) || !omni.canReportPlayback(song)) return null;
    return {
        songKey: getPlaybackSongKey(song),
        mediaId: source.mediaId,
        totalSeconds: getProviderSongMetadata(song).durationMs / 1000,
    };
};

export const useYtMusicScrobbleReporter = (params: UseYtMusicScrobbleReporterParams): void => {
    const enabled = useAudioSettingsStore(state => state.ytmusicScrobbleEnabled);
    usePlaybackScrobbleReporter({
        ...params,
        enabled,
        isReady: isYtMusicScrobbleReady,
        resolveCandidate: resolveScrobbleCandidate,
    });
};
