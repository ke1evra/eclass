import Link from 'next/link'

export default function HomePage() {
  return (
    <main>
      <h1>Экзамен Класс</h1>
      <p>
        Платформа подготовки к ОГЭ/ЕГЭ для учителей и репетиторов.
        PWA-first, разработка строго по TDD.
      </p>
      <p>
        <Link href="/about/mvp">Что входит в MVP →</Link>
      </p>
    </main>
  )
}
