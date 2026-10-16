import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { OmniPlaybackReport } from '@/types/onlineMusic';

// test/unit/hooks/useYtMusicScrobbleReporter.test.ts
// YouTube Music through the shared scrobble engine; the engine's edge cases are pinned in
// useNeteaseScrobbleReporter.test.ts, so this covers only what the YouTube Music wrapper decides.
//
// Harness copied from that file:
// The wiring layer: it alone decides when a listening session opens and when it settles, so the
// branches that only comments could describe until now - an automix deck handover, loop-one, and
// signing out mid-track - are pinned here. The repo's vitest runs on node with no jsdom and no
// testing-library, so this reuses the minimal React runtime from useOnlineProviderQrLogin.test.ts
// and a hand-rolled audio element rather than pulling in a rendering stack.

const runtime = vi.hoisted(() => ({
    slots: [] as { current: any }[],
    cursor: 0,
    effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', () => ({
    useRef: (initial: unknown) => {
        const index = runtime.cursor++;
        runtime.slots[index] ??= { current: initial };
        return runtime.slots[index];
    },
    // The hook's single effect has a dependency array, but every `render` below is a deliberate
    // re-render with changed inputs, so running it each time matches what React would do.
    useEffect: (effect: () => void | (() => void)) => { runtime.effects.push(effect); },
}));

const gate = vi.hoisted(() => ({
    isYtMusicScrobbleReady: vi.fn(() => true),
    // Typed rather than bare, so the assertions below can read the song and report it was handed.
    sendPlaybackReport: vi.fn(async (_song: unknown, _report: unknown) => true),
}));
vi.mock('@/services/onlineMusic/playbackReportGate', () => gate);

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        canReportPlayback: (song: SongResult) => (
            song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'ytmusic'
        ),
    },
}));

vi.mock('@/services/onlineMusic/songMetadata', () => ({
    getProviderSongMetadata: (song: SongResult) => ({ durationMs: song.durationMs ?? 0, artists: [] }),
}));

const audioSettings = vi.hoisted(() => ({ ytmusicScrobbleEnabled: true, audioQuality: 'high' }));
const useAudioSettingsStore = vi.hoisted(() => {
    const hook = (selector: (state: { ytmusicScrobbleEnabled: boolean; audioQuality: string }) => unknown) => selector(audioSettings);
    hook.getState = () => audioSettings;
    return hook;
});
vi.mock('@/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore }));

const { useYtMusicScrobbleReporter } = await import('@/hooks/useYtMusicScrobbleReporter');

/**
 * A clock that moves with playback.
 *
 * The tracker cross-checks accumulated media time against the wall clock, so a test that plays 45
 * seconds of audio in zero real time is - correctly - rejected as impossible. Every tick advances
 * this by its own quarter second, which is what real playback would do.
 */
const clock = { now: 1_700_000_000_000 };

/** The parts of an HTMLAudioElement the hook touches, plus a way to drive its listeners. */
const createDeck = () => {
    const listeners = new Map<string, Set<() => void>>();
    return {
        currentTime: 0,
        paused: false,
        ended: false,
        addEventListener: (type: string, listener: () => void) => {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
        },
        removeEventListener: (type: string, listener: () => void) => {
            listeners.get(type)?.delete(listener);
        },
        emit(type: string) {
            listeners.get(type)?.forEach(listener => listener());
        },
        /** Continuous playback in quarter-second ticks, the way a real deck reports it. */
        playFor(seconds: number) {
            for (let step = 0; step <= Math.round(seconds / 0.25); step += 1) {
                if (step > 0) {
                    this.currentTime = Number((this.currentTime + 0.25).toFixed(4));
                    clock.now += 250;
                }
                this.emit('timeupdate');
            }
        },
    };
};

type Deck = ReturnType<typeof createDeck>;

const song = (mediaId: string, overrides: Partial<SongResult> = {}): SongResult => ({
    id: mediaId,
    name: 'song-' + mediaId,
    artists: [],
    album: { id: '', name: '' },
    durationMs: 240_000,
    sourceRef: { kind: 'online', providerId: 'ytmusic', mediaId },
    ...overrides,
} as SongResult);

/** The song and payload of the nth report, named so the assertions read as intent. */
const reportedSong = (call: number) => gate.sendPlaybackReport.mock.calls[call]?.[0] as SongResult;
const reportedPayload = (call: number) => gate.sendPlaybackReport.mock.calls[call]?.[1] as OmniPlaybackReport;

let cleanups: Array<() => void> = [];
const audioRef: { current: Deck | null } = { current: null };

const render = (currentSong: SongResult | null, activeDeck = 'A') => {
    cleanups.forEach(cleanup => cleanup());
    runtime.cursor = 0;
    runtime.effects.length = 0;
    useYtMusicScrobbleReporter({ audioRef: audioRef as never, currentSong, activeDeck });
    cleanups = runtime.effects
        .map(effect => effect())
        .filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
};

describe('useYtMusicScrobbleReporter', () => {
    let deck: Deck;

    beforeEach(() => {
        runtime.slots.length = 0;
        runtime.cursor = 0;
        runtime.effects.length = 0;
        cleanups = [];
        gate.isYtMusicScrobbleReady.mockReset().mockReturnValue(true);
        gate.sendPlaybackReport.mockReset().mockResolvedValue(true);
        audioSettings.ytmusicScrobbleEnabled = true;
        clock.now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
        deck = createDeck();
        audioRef.current = deck;
    });

    it('reports a YouTube Music track that was really listened to', () => {
        render(song('m9SMT5ipbxk'));
        deck.playFor(45);
        render(song('NhRQqeb0mds'));
        expect(gate.sendPlaybackReport).toHaveBeenCalledTimes(1);
        expect(reportedSong(0)).toMatchObject({ id: 'm9SMT5ipbxk' });
        expect(reportedPayload(0)).toMatchObject({ playedSeconds: 45 });
    });

    it('ignores tracks from other providers and ids that are not video ids', () => {
        render(song('1', { sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } }));
        deck.playFor(45);
        render(song('not-a-video-id'));
        deck.playFor(45);
        render(null);
        expect(gate.sendPlaybackReport).not.toHaveBeenCalled();
    });

    it('sends nothing while the setting is off', () => {
        audioSettings.ytmusicScrobbleEnabled = false;
        render(song('m9SMT5ipbxk'));
        deck.playFor(45);
        render(song('NhRQqeb0mds'));
        expect(gate.sendPlaybackReport).not.toHaveBeenCalled();
    });

    it('sends nothing after signing out mid-track', () => {
        render(song('m9SMT5ipbxk'));
        deck.playFor(45);
        gate.isYtMusicScrobbleReady.mockReturnValue(false);
        render(song('NhRQqeb0mds'));
        expect(gate.sendPlaybackReport).not.toHaveBeenCalled();
    });
});
