import Navbar from './components/Navbar'
import Footer from './components/Footer'
import Hero from './sections/Hero'
import Features from './sections/Features'
import Showcase from './sections/Showcase'
import AudioComparison from './sections/AudioComparison'
import CallToAction from './sections/CallToAction'

export default function App() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <Showcase />
        <AudioComparison />
        <CallToAction />
      </main>
      <Footer />
    </>
  )
}
