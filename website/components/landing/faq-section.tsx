'use client';

import Image from 'next/image';
import { useState } from 'react';

const questions = [
  {
    question: 'What is Wolf-Cut?',
    answer:
      'Wolf-Cut is a free, open-source desktop video editor built around a native Rust engine and a focused editing interface.',
  },
  {
    question: 'Is Wolf-Cut really free?',
    answer:
      'Yes. The application is free software, with no subscription, account, or paid feature tier required to edit your videos.',
  },
  {
    question: 'Does Wolf-Cut upload my videos?',
    answer:
      'No required cloud upload is part of the editing workflow. Your source media and creative process stay on your machine.',
  },
  {
    question: 'Does it add a watermark?',
    answer:
      'No. Wolf-Cut does not add branded watermarks to your exported videos.',
  },
  {
    question: 'Which operating systems are supported?',
    answer:
      'Desktop builds are available for macOS, Windows, and Linux. Wolf-Cut is currently an alpha release, so platform testing is still evolving.',
  },
  {
    question: 'Where can I view the source code?',
    answer:
      'The complete source is public in the Wolf-Cut GitHub repository, where you can inspect the code, report issues, and contribute.',
  },
] as const;

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="faq-panel">
      <div className="faq-list">
        {questions.map((item, index) => {
          const open = openIndex === index;
          const buttonId = `faq-button-${index}`;
          const panelId = `faq-panel-${index}`;

          return (
            <div className="faq-item" data-open={open} key={item.question}>
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setOpenIndex(open ? null : index)}
                >
                  <span>{item.question}</span>
                  <span className="faq-symbol" aria-hidden="true">
                    {open ? '−' : '+'}
                  </span>
                </button>
              </h3>
              <section
                id={panelId}
                className="faq-answer"
                aria-labelledby={buttonId}
                aria-hidden={!open}
                data-open={open}
              >
                <p>{item.answer}</p>
              </section>
            </div>
          );
        })}
      </div>

      <div className="faq-visual">
        <Image
          src="/editor-preview.webp"
          alt="Wolf-Cut editor showing the preview canvas and editing timeline"
          width={1920}
          height={1175}
          sizes="(max-width: 1179px) 90vw, 560px"
        />
        <div className="faq-visual-label">
          <span className="status-dot" />
          <span>Local editing session</span>
        </div>
      </div>
    </div>
  );
}
