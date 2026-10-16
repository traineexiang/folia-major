import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, Loader2, X } from 'lucide-react';

// src/library/suites/grid/account/OnlineProviderCookieLoginModal.tsx
// Sign-in by pasted cookie, for providers without a QR flow (YouTube Music). Same frame as
// OnlineProviderLoginModal. The cookie lives only in this field until it is submitted; it is a
// password-style input so it is not shown on screen. All copy arrives translated.

type OnlineProviderCookieLoginModalProps = {
    title: string;
    note: string;
    steps: string[];
    openSiteLabel: string;
    onOpenSite: () => void;
    fieldLabel: string;
    placeholder: string;
    submitLabel: string;
    submittingLabel: string;
    storageNote: string;
    /** Translated reason the last attempt failed; null when there is none. */
    error: string | null;
    submitting: boolean;
    closeLabel: string;
    onSubmit: (cookie: string) => void;
    onClose: () => void;
};

const OnlineProviderCookieLoginModal = ({
    title,
    note,
    steps,
    openSiteLabel,
    onOpenSite,
    fieldLabel,
    placeholder,
    submitLabel,
    submittingLabel,
    storageNote,
    error,
    submitting,
    closeLabel,
    onSubmit,
    onClose,
}: OnlineProviderCookieLoginModalProps) => {
    const [cookie, setCookie] = useState('');
    const canSubmit = cookie.trim().length > 0 && !submitting;
    const submit = (event: React.FormEvent) => {
        event.preventDefault();
        if (canSubmit) onSubmit(cookie);
    };
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4"
            role="dialog"
            aria-modal="true"
            aria-label={title}
        >
            <motion.form
                onSubmit={submit}
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                className="bg-zinc-900/90 border border-white/10 p-8 rounded-3xl w-full max-w-md max-h-full overflow-y-auto text-left relative shadow-2xl"
            >
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    className="absolute top-4 right-4 opacity-40 hover:opacity-100 rounded-full bg-white/5 p-1 transition-colors cursor-pointer"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <X size={16} />
                </button>
                <h3 className="text-lg font-bold mb-2 text-center" style={{ color: 'var(--text-primary)' }}>{title}</h3>
                <p className="text-xs opacity-60 mb-5 text-center" style={{ color: 'var(--text-secondary)' }}>{note}</p>
                <ol className="list-decimal pl-5 space-y-1.5 text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                    {steps.map(step => <li key={step}>{step}</li>)}
                </ol>
                <button
                    type="button"
                    onClick={onOpenSite}
                    className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
                >
                    <ExternalLink size={13} />
                    {openSiteLabel}
                </button>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45 mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {fieldLabel}
                    <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={cookie}
                        onChange={event => setCookie(event.target.value)}
                        placeholder={placeholder}
                        disabled={submitting}
                        className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm normal-case tracking-normal text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
                    />
                </label>
                {error && (
                    <p role="alert" className="text-xs text-red-300 mb-3">{error}</p>
                )}
                <button
                    type="submit"
                    disabled={!canSubmit}
                    className="mt-1 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-white/90 px-4 py-2.5 text-sm font-semibold text-black transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                    {submitting && <Loader2 size={14} className="animate-spin" />}
                    {submitting ? submittingLabel : submitLabel}
                </button>
                <p className="mt-3 text-[11px] opacity-45 text-center" style={{ color: 'var(--text-secondary)' }}>{storageNote}</p>
            </motion.form>
        </motion.div>
    );
};

export default OnlineProviderCookieLoginModal;
