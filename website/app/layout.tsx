import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'WolfCut — Free, local video editor',
  description:
    'Download WolfCut for macOS, Windows, and Linux. Edit videos locally without watermarks or subscriptions.',
  openGraph: {
    title: 'WolfCut — Your videos. Your rules.',
    description: 'Free, local video editor for macOS, Windows, and Linux.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'WolfCut — Your videos. Your rules.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WolfCut — Your videos. Your rules.',
    description: 'Free, local video editor for macOS, Windows, and Linux.',
    images: ['/og.png'],
  },
  icons: {
    icon: '/wolfcut-logo.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
