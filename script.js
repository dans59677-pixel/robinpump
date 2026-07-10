/* ===========================
   ROBINPUMP — script.js
   =========================== */

'use strict';

/* --- Navbar scroll effect --- */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 40) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}, { passive: true });

/* --- Hamburger menu --- */
const hamburger = document.getElementById('hamburger');
const navLinks = document.getElementById('navLinks');

hamburger.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', isOpen);
});

// Close menu when a link is clicked
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    hamburger.setAttribute('aria-expanded', false);
  });
});

/* --- Hero particles --- */
function createParticles() {
  const container = document.getElementById('particles');
  if (!container) return;

  const count = 30;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.classList.add('particle');

    const size = Math.random() * 4 + 2;
    const left = Math.random() * 100;
    const dur = Math.random() * 8 + 5;
    const delay = Math.random() * 8;

    p.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      left: ${left}%;
      --dur: ${dur}s;
      --delay: ${delay}s;
      opacity: 0;
    `;
    container.appendChild(p);
  }
}
createParticles();

/* --- Intersection Observer for fade-up animations --- */
const observerOptions = {
  threshold: 0.12,
  rootMargin: '0px 0px -40px 0px'
};

const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const delay = el.dataset.delay ? parseInt(el.dataset.delay) : 0;
      setTimeout(() => {
        el.classList.add('visible');
      }, delay);
      fadeObserver.unobserve(el);
    }
  });
}, observerOptions);

// Observe feature cards
document.querySelectorAll('.feature-card').forEach(el => {
  fadeObserver.observe(el);
});

// Generic fade-up for section elements
function addFadeUp(selectors) {
  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      el.classList.add('fade-up');
      fadeObserver.observe(el);
    });
  });
}

addFadeUp([
  '.section-title',
  '.section-label',
  '.about-text',
  '.about-visual',
  '.story-card',
  '.token-card',
  '.roadmap-item',
  '.community-card',
  '.faq-item',
  '.tokenomics-note'
]);

/* --- FAQ Accordion --- */
document.querySelectorAll('.faq-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const answer = item.querySelector('.faq-answer');
    const isOpen = item.classList.contains('open');

    // Close all
    document.querySelectorAll('.faq-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.faq-answer').classList.remove('open');
      i.querySelector('.faq-question').setAttribute('aria-expanded', false);
    });

    // Open clicked if it was closed
    if (!isOpen) {
      item.classList.add('open');
      answer.classList.add('open');
      btn.setAttribute('aria-expanded', true);
    }
  });
});

/* --- Smooth active nav link highlight --- */
const sections = document.querySelectorAll('section[id]');
const navAnchors = document.querySelectorAll('.nav-links a');

const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.getAttribute('id');
      navAnchors.forEach(a => {
        a.style.color = '';
        if (a.getAttribute('href') === `#${id}`) {
          a.style.color = 'var(--green)';
        }
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => sectionObserver.observe(s));

/* --- Feather card parallax on mousemove (about section) --- */
const featherCard = document.querySelector('.feather-card');
if (featherCard) {
  featherCard.addEventListener('mousemove', (e) => {
    const rect = featherCard.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    featherCard.style.transform = `
      translateY(-6px)
      rotateX(${-y * 10}deg)
      rotateY(${x * 10}deg)
    `;
  });
  featherCard.addEventListener('mouseleave', () => {
    featherCard.style.transform = '';
  });
}

/* --- Copy contract address (placeholder) --- */
document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', () => {
    const text = btn.dataset.copy;
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  });
});
