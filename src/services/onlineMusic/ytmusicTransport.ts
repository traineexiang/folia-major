import { OnlineProviderError, type ProviderErrorCode } from '../../types/onlineMusic';

// src/services/onlineMusic/ytmusicTransport.ts
// The only renderer path to the YouTube Music bridge (electron/ytmusicApiBridge.cjs). The cookie and
// googlevideo URLs stay in the main process; this file only sees bridge DTOs.

export type YtMusicOperation =
    | 'status' | 'login_cookie' | 'logout' | 'account' | 'audio' | 'home' | 'search' | 'playlist'
    | 'album' | 'library_playlists' | 'liked_ids' | 'up_next' | 'like' | 'report_play';

export type YtMusicBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

export const getYtMusicTransportAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.ytmusicRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

const PASSTHROUGH_CODES: ProviderErrorCode[] = ['auth-required', 'not-playable', 'network', 'unsupported', 'invalid-response'];

export const toYtMusicProviderError = (error: { code: string; message: string }): OnlineProviderError => {
    // youtubei.js no longer understands YouTube's responses: retrying will not help, updating the package will.
    if (error.code === 'update-needed') {
        return new OnlineProviderError('unavailable', error.message, 'ytmusic', undefined, undefined, undefined,
            { stage: 'upstream', upstreamCode: 'update-needed', transient: false });
    }
    const code = PASSTHROUGH_CODES.includes(error.code as ProviderErrorCode)
        ? error.code as ProviderErrorCode
        : 'invalid-response';
    return new OnlineProviderError(code, error.message, 'ytmusic', undefined, undefined, undefined,
        { stage: 'upstream', upstreamCode: error.code });
};

export async function requestYtMusic<T = unknown>(operation: YtMusicOperation, params: Record<string, unknown> = {}): Promise<T> {
    if (!getYtMusicTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', 'YouTube Music requires the desktop app', 'ytmusic',
            undefined, undefined, undefined, { stage: 'runtime', transient: false });
    }
    let result: YtMusicBridgeResult;
    try { result = await window.electron!.ytmusicRequest!(operation, params); }
    catch (error) {
        throw new OnlineProviderError('unavailable', 'YouTube Music desktop request failed', 'ytmusic',
            error, undefined, undefined, { stage: 'ipc' });
    }
    if (!result.ok) throw toYtMusicProviderError(result.error);
    return result.data as T;
}
