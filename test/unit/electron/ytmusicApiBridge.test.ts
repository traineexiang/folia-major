import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/ytmusicApiBridge.test.ts — credential custody, IPC surface and the chunked audio scheme.
// youtubei.js itself is stubbed: these tests pin the host contract, not YouTube's responses.

const require = createRequire(import.meta.url);
const { createYtMusicApiBridge } = require('../../../electron/ytmusicApiBridge.cjs');
const { createYtMusicSessionRepository, SESSION_KEY } = require('../../../electron/ytmusic/session.cjs');
const { createProtocolResponse, parseYtMusicAudioUrl } = require('../../../electron/ytmusic/audioProtocol.cjs');

const COOKIE = 'SAPISID=fixture-private; __Secure-3PSID=fixture-private-2; PREF=x';
const STREAM = 'https://rr1---sn-abc.googlevideo.com/videoplayback?id=o-1&itag=140&expire=1900000000';

const createStore = () => {
    const values = new Map<string, unknown>();
    return { values, get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
};
const cipher = () => ({ isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xa5)),
    decryptString: (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0xa5)).toString() });

const fakeYoutubei = ({ loggedIn = true, basicInfo = vi.fn() } = {}) => {
    const create = vi.fn(async (_options: { cookie?: string }) => ({
        session: { logged_in: loggedIn, player: {} },
        getBasicInfo: basicInfo,
        music: { getHomeFeed: async () => ({ sections: [] }) },
    }));
    return { create, load: async () => ({ Innertube: { create }, Platform: { shim: {} }, UniversalCache: class {} }) };
};

describe('YouTube Music session repository', () => {
    it('stores the cookie sealed, never as plaintext', () => {
        const store = createStore();
        createYtMusicSessionRepository({ store, safeStorage: cipher() }).set(COOKIE);
        expect(String(store.values.get(SESSION_KEY))).not.toContain('fixture-private');
        expect(createYtMusicSessionRepository({ store, safeStorage: cipher() }).get()?.cookie).toBe(COOKIE);
    });
    it('refuses cookies without the sign-in values', () => {
        const sessions = createYtMusicSessionRepository({ store: createStore(), safeStorage: cipher() });
        expect(() => sessions.set('PREF=x; YSC=y')).toThrow();
    });
    it('keeps the session in memory only when encryption is basic_text', () => {
        const store = createStore();
        const safeStorage = { ...cipher(), getSelectedStorageBackend: () => 'basic_text' };
        const sessions = createYtMusicSessionRepository({ store, safeStorage, warn: () => {} });
        sessions.set(COOKIE);
        expect(sessions.get()?.cookie).toBe(COOKIE);
        expect(store.values.has(SESSION_KEY)).toBe(false);
    });
});

describe('YouTube Music bridge', () => {
    it('rejects unknown operations and never echoes the cookie', async () => {
        const store = createStore();
        createYtMusicSessionRepository({ store, safeStorage: cipher() }).set(COOKIE);
        const { load } = fakeYoutubei();
        const bridge = createYtMusicApiBridge({ store, safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('constructor')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        for (const operation of ['status', 'home', 'logout']) {
            expect(JSON.stringify(await bridge.request(operation))).not.toContain('fixture-private');
        }
    });
    it('accepts a pasted cookie header and rejects one without sign-in values', async () => {
        const store = createStore();
        const { load, create } = fakeYoutubei();
        const bridge = createYtMusicApiBridge({ store, safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('login_cookie', { cookie: 'PREF=x' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
        expect(create).not.toHaveBeenCalled();
        expect(await bridge.request('login_cookie', { cookie: `cookie: ${COOKIE}` })).toEqual({ ok: true, data: { signedIn: true } });
        expect(create.mock.calls.at(-1)?.[0].cookie).toBe(COOKIE);
        expect(await bridge.request('status')).toMatchObject({ ok: true, data: { signedIn: true } });
    });
    it('drops a cookie that YouTube does not accept as signed in', async () => {
        const store = createStore();
        const { load } = fakeYoutubei({ loggedIn: false });
        const bridge = createYtMusicApiBridge({ store, safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('login_cookie', { cookie: COOKIE })).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(store.values.has(SESSION_KEY)).toBe(false);
    });
    it('requires sign-in for library reads', async () => {
        const { load } = fakeYoutubei();
        const bridge = createYtMusicApiBridge({ store: createStore(), safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('home')).toMatchObject({ ok: false, error: { code: 'auth-required' } });
    });
    it('validates the video id before calling YouTube', async () => {
        const basicInfo = vi.fn();
        const { load } = fakeYoutubei({ basicInfo });
        const bridge = createYtMusicApiBridge({ store: createStore(), safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('audio', { videoId: '../../etc' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
        expect(basicInfo).not.toHaveBeenCalled();
    });
    it('hides the upstream URL and falls back to the next client', async () => {
        const store = createStore();
        createYtMusicSessionRepository({ store, safeStorage: cipher() }).set(COOKIE);
        const basicInfo = vi.fn()
            .mockRejectedValueOnce(new Error('Request failed with status code 400'))
            .mockResolvedValueOnce({
                playability_status: { status: 'OK' },
                basic_info: { duration: 214 },
                chooseFormat: () => ({ mime_type: 'audio/mp4', bitrate: 130000, content_length: 10, decipher: async () => STREAM }),
            });
        const { load } = fakeYoutubei({ basicInfo });
        const bridge = createYtMusicApiBridge({ store, safeStorage: cipher(), loadYoutubei: load, now: () => 0 });
        const result = await bridge.request('audio', { videoId: 'm9SMT5ipbxk' });
        expect(result).toMatchObject({ ok: true, data: { url: 'ytmusic-audio://media/m9SMT5ipbxk', client: 'ANDROID_VR', preview: true, expiresAt: 1900000000000 } });
        expect(JSON.stringify(result)).not.toContain('googlevideo');
        // The protocol reuses the resolved stream instead of asking YouTube again.
        expect((await bridge.resolveStream('m9SMT5ipbxk')).url).toBe(STREAM);
        expect(basicInfo).toHaveBeenCalledTimes(2);
    });
    it('reports parser breakage as update-needed', async () => {
        const store = createStore();
        createYtMusicSessionRepository({ store, safeStorage: cipher() }).set(COOKIE);
        const { load } = fakeYoutubei({ basicInfo: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'ParsingError' })) });
        const bridge = createYtMusicApiBridge({ store, safeStorage: cipher(), loadYoutubei: load });
        expect(await bridge.request('audio', { videoId: 'm9SMT5ipbxk' })).toMatchObject({ ok: false, error: { code: 'update-needed' } });
    });
});

describe('YouTube Music audio scheme', () => {
    const SIZE = 2_500_000;
    const stream = { url: STREAM, contentLength: SIZE, mimeType: 'audio/mp4; codecs="mp4a.40.2"' };
    const upstream = () => vi.fn(async (_url: string, init: { headers: { Range: string } }) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
        return new Response(new Uint8Array(Number(b) - Number(a) + 1), { status: 206 });
    });
    const request = (range?: string) => new Request('ytmusic-audio://media/m9SMT5ipbxk', { headers: range ? { range } : {} });

    it('accepts only well-formed video ids', () => {
        expect(parseYtMusicAudioUrl('ytmusic-audio://media/m9SMT5ipbxk')).toBe('m9SMT5ipbxk');
        expect(parseYtMusicAudioUrl('ytmusic-audio://media/../secret')).toBeNull();
        expect(parseYtMusicAudioUrl('ytmusic-audio://other/m9SMT5ipbxk')).toBeNull();
    });
    it('turns the media element open range into bounded upstream chunks', async () => {
        const fetchImpl = upstream();
        const response = await createProtocolResponse(request('bytes=0-'), { resolveStream: async () => stream, fetchImpl });
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
        expect(response.headers.get('content-type')).toBe('audio/mp4');
        expect((await response.arrayBuffer()).byteLength).toBe(SIZE);
        const ranges = fetchImpl.mock.calls.map(call => call[1].headers.Range);
        expect(ranges).toEqual(['bytes=0-1048575', 'bytes=1048576-2097151', `bytes=2097152-${SIZE - 1}`]);
    });
    it('re-resolves once when the signed URL expires mid-stream', async () => {
        const resolveStream = vi.fn(async (_id: string, { refresh }: { refresh: boolean }) => (refresh ? { ...stream, url: `${STREAM}&fresh=1` } : stream));
        const fetchImpl = vi.fn(async (url: string) => (url.includes('fresh') ? new Response(new Uint8Array(10), { status: 206 }) : new Response(null, { status: 403 })));
        const response = await createProtocolResponse(request('bytes=0-9'), { resolveStream, fetchImpl });
        expect((await response.arrayBuffer()).byteLength).toBe(10);
        expect(resolveStream).toHaveBeenLastCalledWith('m9SMT5ipbxk', { refresh: true });
    });
    it('rejects ranges outside the stream', async () => {
        const response = await createProtocolResponse(request(`bytes=${SIZE}-`), { resolveStream: async () => stream, fetchImpl: upstream() });
        expect(response.status).toBe(416);
    });
});
