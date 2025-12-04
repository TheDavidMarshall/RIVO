// Version 6 script with a small CTA entrance animation/interaction.
// - Minimal React hydration for Spam Counter (unchanged).
// - Adds a small JS routine that animates the center CTA (.center__beta) into view
//   after the page and widget animations settle. Respects prefers-reduced-motion.

import React from "https://esm.sh/react@18.2.0";
import { createRoot } from "https://esm.sh/react-dom@18.2.0/client";

const DASHBOARD_URL = document.body.getAttribute('data-dashboard-url') || '/dashboard';
const SPAM_METRICS_API = '/api/spam-metrics'; // replace with real endpoint

const FALLBACK = {
  spamCount: 218,
  sitesLinked: 573,
  pointsA: [0, 0.05, 0.05, 0.23, 0.22, 0.35, 0.25, 0.58, 0.54, 0.93, 0.9],
  pointsB: [0, 0, 0.25, 0.17, 0.21, 0.18, 0.53, 0.83, 0.39, 0.42]
};

function pointsToPolyline(points, width = 120, height = 40, margin = 0) {
  const w = width - margin * 2;
  const h = height - margin * 2;
  return points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - p * h;
    return `${x + margin} ${y + margin}`;
  }).join(',');
}

function SpamCounter({ spamCount, sitesLinked, pointsA }) {
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const poly = pointsToPolyline(pointsA, 120, 40);
  return React.createElement('div', { className: 'spam-counter-inner' }, [
    React.createElement('div', { key: 'big', className: 'widget__amount widget__amount--lg' },
      React.createElement('span', { className: 'widget__value' }, nf.format(spamCount))
    ),
    React.createElement('div', { key: 'label', className: 'widget__label' }, 'Websites spamming you — total of'),
    React.createElement('div', { key: 'sites', className: 'left__sites' },
      React.createElement('svg', { className: 'icon', width: 16, height: 16 }, React.createElement('use', { href: '#envelope' })),
      React.createElement('span', { id: 'sites-linked', className: 'widget__value small' }, nf.format(sitesLinked)),
      React.createElement('span', { className: 'widget__muted' }, 'websites linked to your email')
    ),
    React.createElement('svg', { key: 'spark', className: 'sparkline', viewBox: '0 0 120 40', width: 120, height: 40, 'aria-hidden': true },
      React.createElement('polyline', { points: poly, fill: 'none', stroke: 'currentColor', strokeWidth: 2 })
    )
  ]);
}

async function fetchSpamMetrics() {
  try {
    const resp = await fetch(SPAM_METRICS_API, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Network error');
    const json = await resp.json();
    if (typeof json.spamCount === 'number' && typeof json.sitesLinked === 'number' && Array.isArray(json.pointsA)) {
      return json;
    } else {
      console.warn('API returned unexpected shape, using fallback');
    }
  } catch (err) {
    console.warn('Fetching spam metrics failed, using fallback', err);
  }
  return FALLBACK;
}

(async function hydrate() {
  const mount = document.getElementById('spam-counter-root');
  if (!mount) return;
  const data = await fetchSpamMetrics();
  createRoot(mount).render(React.createElement(SpamCounter, {
    spamCount: data.spamCount,
    sitesLinked: data.sitesLinked,
    pointsA: data.pointsA,
    pointsB: data.pointsB
  }));
})();

/* UI handlers and CTA animation */
(function ui() {
  const mobileNav = document.getElementById('mobile-nav');
  const navBackdrop = document.getElementById('nav-backdrop');
  const menuOpen = document.getElementById('menu-open');
  const navClose = document.getElementById('nav-close');
  const navTry = document.getElementById('nav-try');
  const closeDuration = 300;

  function openMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.remove('closing'); mobileNav.classList.add('open'); mobileNav.setAttribute('aria-hidden','false');
    navBackdrop.style.display = 'block'; navBackdrop.setAttribute('aria-hidden','false');
  }
  function closeMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.remove('open'); mobileNav.classList.add('closing'); mobileNav.setAttribute('aria-hidden','true');
    navBackdrop.setAttribute('aria-hidden','true');
    setTimeout(()=>{ mobileNav.classList.remove('closing'); navBackdrop.style.display = ''; }, closeDuration);
  }

  menuOpen && menuOpen.addEventListener('click', openMobileNav);
  navClose && navClose.addEventListener('click', closeMobileNav);
  navBackdrop && navBackdrop.addEventListener('click', closeMobileNav);
  navTry && navTry.addEventListener('click', ()=> { closeMobileNav(); window.location.href = DASHBOARD_URL; });

  document.querySelectorAll('a#try-it, a#nav-try').forEach(a => a.setAttribute('href', DASHBOARD_URL));

  const top = document.getElementById('top');
  if (top && top.classList.contains('first-load')) setTimeout(()=> top.classList.remove('first-load'), 2200);

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileNav(); });

  // CTA entrance animation
  function animateCTA() {
    const cta = document.querySelector('.center__beta');
    if (!cta) return;
    // respect reduced motion
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq && mq.matches) {
      cta.classList.add('enter');
      return;
    }

    // Wait until the widgets entrance animations have finished (approx)
    // then add the 'enter' class to trigger CSS transition.
    setTimeout(() => {
      cta.classList.add('enter');

      // subtle periodic micro-pulse to draw attention (low-impact)
      let pulsing = false;
      const pulseInterval = 7000; // every 7s
      const doPulse = () => {
        if (pulsing) return;
        pulsing = true;
        cta.animate([
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(-3px) scale(1.02)' },
          { transform: 'translateY(0) scale(1)' }
        ], { duration: 550, easing: 'cubic-bezier(.2,.9,.2,1)' });
        setTimeout(() => { pulsing = false; }, 700);
      };
      const intervalId = setInterval(doPulse, pulseInterval);

      // stop pulsing when user interacts with CTA
      cta.addEventListener('pointerenter', () => { clearInterval(intervalId); }, { once: true });
    }, 900); // tuned delay so it occurs after widget roll-in
  }

  // Run on DOMContentLoaded to ensure elements exist
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', animateCTA);
  } else {
    animateCTA();
  }
})();