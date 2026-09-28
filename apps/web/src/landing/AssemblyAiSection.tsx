import s from './AssemblyAiSection.module.css';
import sec from './Section.module.css';

const AssemblyAiMark = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <g fill="currentColor">
      <rect x="0" y="4" width="2" height="4" rx="1" />
      <rect x="3.3" y="1.5" width="2" height="9" rx="1" />
      <rect x="6.6" y="3" width="2" height="6" rx="1" />
      <rect x="9.9" y="4.5" width="2" height="3" rx="1" />
    </g>
  </svg>
);

/** "Built on AssemblyAI": the technology band between practice line and footer. */
export function AssemblyAiSection() {
  return (
    <section className={s.aai} aria-label="Technology">
      <div className={sec.wrap}>
        <p>
          Live captions and turn-taking run on{' '}
          <span className={s.mark}>
            <AssemblyAiMark />
            AssemblyAI
          </span>{' '}
          real-time speech recognition. Every word arrives with a confidence score, so an unsure
          word gets a <span className={s.lcx}>dotted underline</span> instead of a quiet guess.
        </p>
      </div>
    </section>
  );
}
