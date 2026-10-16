// electron/ytmusic/session.cjs
// The YouTube Music cookie is a full Google account credential: it is sealed with safeStorage, never
// leaves the main process, and is held in memory only when the OS encryption service is unavailable.

const SESSION_KEY = 'YTMUSIC_SESSION_V1';
// Without these two cookies YouTube treats requests as signed out (SAPISIDHASH and the session id).
const REQUIRED_COOKIES = ['SAPISID', '__Secure-3PSID'];

const parseCookieNames = cookie => new Set(String(cookie)
  .split(';')
  .map(part => part.split('=')[0].trim())
  .filter(Boolean));

const isUsableCookie = cookie => typeof cookie === 'string'
  && REQUIRED_COOKIES.every(name => parseCookieNames(cookie).has(name));

// Credentials are loaded lazily, after Electron's OS encryption service becomes available.
function createYtMusicSessionRepository({ store, safeStorage, warn = console.warn }) {
  let loaded = false;
  let current = null;
  let revision = 0;
  const canEncrypt = () => safeStorage?.isEncryptionAvailable()
    && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  return {
    get revision() { return revision; },
    get() {
      if (loaded) return current;
      loaded = true;
      try {
        const sealed = store.get(SESSION_KEY);
        if (typeof sealed !== 'string' || !canEncrypt()) return null;
        const value = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')));
        if (value.version === 1 && isUsableCookie(value.cookie)) current = value;
      } catch { warn('[YtMusicSession] Encrypted session could not be restored'); }
      return current;
    },
    set(cookie) {
      if (!isUsableCookie(cookie)) throw new Error('Cookie is missing the YouTube sign-in values');
      loaded = true;
      current = { version: 1, cookie };
      revision++;
      try {
        if (!canEncrypt()) throw new Error('Encryption unavailable');
        store.set(SESSION_KEY, safeStorage.encryptString(JSON.stringify(current)).toString('base64'));
      } catch {
        store.delete(SESSION_KEY);
        warn('[YtMusicSession] Login is available for this run only; OS encryption is unavailable');
      }
    },
    clear() {
      loaded = true;
      current = null;
      revision++;
      store.delete(SESSION_KEY);
    },
  };
}

module.exports = { createYtMusicSessionRepository, isUsableCookie, SESSION_KEY };
