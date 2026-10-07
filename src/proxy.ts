import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

const proxy = createMiddleware(routing);

export default proxy;

export const config = {
    // Public metadata routes and static assets must stay at the host root.
    matcher: [
        '/((?!api|setup(?:/|$)|m|_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|webp|svg|gif|ico|mp4|mov|mp3|wav|m4a)).*)'
    ]
};
