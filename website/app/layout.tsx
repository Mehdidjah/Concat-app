import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, Inter } from 'next/font/google';
import { SmoothScrollProvider } from '@/components/landing/smooth-scroll-provider';
import './globals.css';

const editorial = Instrument_Serif({
  variable: '--font-editorial',
  weight: '400',
  subsets: ['latin'],
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://concat-app.vercel.app'),
  applicationName: 'Concat',
  title: 'Concat | Your videos. Your rules.',
  description:
    'A fast, private video editor without watermarks, subscriptions, or cloud uploads. Download Concat for macOS, Windows, and Linux.',
  openGraph: {
    title: 'Concat | Your videos. Your rules.',
    description:
      'A free, open-source video editor that keeps your creative process local.',
    siteName: 'Concat',
    url: '/',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Concat — Your videos. Your rules.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Concat | Your videos. Your rules.',
    description:
      'A free, open-source video editor that keeps your creative process local.',
    images: ['/og.png'],
  },
  icons: {
    icon: '/concat-logo-green.png',
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#07080c',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${editorial.variable} ${inter.variable}`}>
        <SmoothScrollProvider>{children}</SmoothScrollProvider>
      </body>
    </html>
  );
}
