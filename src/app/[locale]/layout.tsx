import type { Metadata } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { isRuntimeConfigured } from '@/lib/runtime-config/store';
import { Providers } from "./providers";

import { locales } from '@/i18n/routing';



type SupportedLocale = (typeof locales)[number]

// 动态元数据生成
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: 'layout' })

    return {
        title: t('title'),
        description: t('description'),
        icons: {
            icon: [{ url: '/favicon.ico', type: 'image/x-icon' }],
            shortcut: '/favicon.ico',
            apple: '/logo.png',
        },
    };
}

export function generateStaticParams() {
    // Resolve locales on demand in dev: Next 16.3.4 can concurrently overwrite
    // its prerender manifest while compiling different locale pages.
    if (process.env.NODE_ENV === 'development') return [];
    return locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;

    if (process.env.NEXT_PHASE !== 'phase-production-build' && !isRuntimeConfigured()) {
        redirect('/setup');
    }

    // 验证 locale 是否有效
    if (!locales.includes(locale as SupportedLocale)) {
        notFound();
    }

    setRequestLocale(locale);

    // 获取翻译消息
    const messages = await getMessages();

    return (
        <NextIntlClientProvider messages={messages}>
            <Providers>
                {children}
            </Providers>
        </NextIntlClientProvider>
    );
}
