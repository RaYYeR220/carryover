import { AssemblyAiSection } from './AssemblyAiSection';
import { AutonomySection } from './AutonomySection';
import { Footer } from './Footer';
import { Hero } from './Hero';
import { HowSection } from './HowSection';
import { Nav } from './Nav';
import { PracticeSection } from './PracticeSection';
import { PrivacySection } from './PrivacySection';

/**
 * The landing page: a faithful port of Glyph Night's index.html. `?still`
 * (and OS reduced motion) freezes every animation for screenshots.
 */
export default function LandingPage() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <HowSection />
        <AutonomySection />
        <PrivacySection />
        <PracticeSection />
        <AssemblyAiSection />
      </main>
      <Footer />
    </>
  );
}
