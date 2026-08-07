import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Экзамен Класс',
  description: 'Платформа подготовки к ОГЭ/ЕГЭ (PWA-first, TDD).',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
