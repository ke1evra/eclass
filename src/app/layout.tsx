import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Экзамен Класс',
  description: 'Платформа подготовки к ОГЭ/ЕГЭ (PWA-first, TDD).',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
}

export const viewport = {
  themeColor: '#1d4ed8',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
