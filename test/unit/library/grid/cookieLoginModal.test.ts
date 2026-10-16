import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import OnlineProviderCookieLoginModal from '../../../../src/library/suites/grid/account/OnlineProviderCookieLoginModal';
import en from '../../../../src/i18n/locales/en';
import zh from '../../../../src/i18n/locales/zh-CN';
import id from '../../../../src/i18n/locales/in';

// test/unit/library/grid/cookieLoginModal.test.ts — the paste-cookie sign-in window and its copy.

const props = (overrides: Partial<Parameters<typeof OnlineProviderCookieLoginModal>[0]> = {}) => ({
    title: 'Sign in to YouTube Music', note: 'note', steps: ['one', 'two'],
    openSiteLabel: 'Open music.youtube.com', onOpenSite: vi.fn(),
    fieldLabel: 'Cookie', placeholder: 'Paste', submitLabel: 'Sign in', submittingLabel: 'Checking',
    storageNote: 'Stored encrypted', error: null, submitting: false, closeLabel: 'Close',
    onSubmit: vi.fn(), onClose: vi.fn(),
    ...overrides,
});

describe('OnlineProviderCookieLoginModal', () => {
    it('hides the pasted cookie and keeps submit off until something is pasted', () => {
        const html = renderToStaticMarkup(createElement(OnlineProviderCookieLoginModal, props()));
        expect(html).toContain('type="password"');
        expect(html).toMatch(/<button type="submit" disabled=""/);
        expect(html).toContain('Open music.youtube.com');
        expect(html).not.toContain('role="alert"');
    });

    it('shows the failure reason and the submitting state', () => {
        const html = renderToStaticMarkup(createElement(OnlineProviderCookieLoginModal, props({ error: 'expired', submitting: true })));
        expect(html).toContain('role="alert"');
        expect(html).toContain('expired');
        expect(html).toContain('Checking');
    });

    it.each([['en', en], ['zh-CN', zh], ['in', id]])('has every cookie-login string in %s', (_locale, locale) => {
        const home = (locale as { translation?: Record<string, any> }).translation?.home ?? (locale as Record<string, any>).home;
        const copy = home.ytmusicCookieLogin;
        expect(copy.steps).toHaveLength(4);
        for (const key of ['openSite', 'field', 'placeholder', 'submit', 'submitting', 'storage', 'error_invalid', 'error_rejected', 'error_failed']) {
            expect(typeof copy[key], key).toBe('string');
        }
        expect(typeof home.loginTitleYtMusic).toBe('string');
        expect(typeof home.cookieLoginUseGrid).toBe('string');
    });
});
