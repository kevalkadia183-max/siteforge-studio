import { MediaAsset, SiteProject, PageId } from './types';

export type GeneratedSite = {
  pages: Record<string, string>; // "index.html", "about.html"
  css: string;
  js: string;
  media: Record<string, MediaAsset>;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character as keyof typeof escapeHtml] ?? character);

const fontStack = (font: string) => {
  const stacks: Record<string, string> = {
    'Manrope': 'Arial, Helvetica, sans-serif',
    'Inter': 'Arial, Helvetica, sans-serif',
    'Playfair Display': 'Georgia, "Times New Roman", serif',
    'Fraunces': 'Georgia, "Times New Roman", serif',
    'DM Sans': '"Trebuchet MS", Arial, sans-serif',
    'Outfit': '"Trebuchet MS", Arial, sans-serif',
    'Space Mono': '"Courier New", ui-monospace, monospace'
  };
  return stacks[font] || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
};

const validEmailOrEmpty = (email: string) => {
  const trimmed = email.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(trimmed) ? trimmed : '';
};

const sanitizeEmail = (email: string) => validEmailOrEmpty(email) || 'hello@example.com';

const supportedMediaTypes = new Set<MediaAsset['mimeType']>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);
function generateCss(project: SiteProject): string {
  const t = project.designTokens;
  const radiusMap = { none: '0', sm: '0.25rem', md: '0.5rem', lg: '1rem', full: '9999px' };
  
  return `
/* Base & Reset */
:root {
  --primary: ${t.primaryColor};
  --font-heading: ${fontStack(t.fontHeading)};
  --font-body: ${fontStack(t.fontBody)};
  --radius: ${radiusMap[t.borderRadius]};
}

html { box-sizing: border-box; font-family: var(--font-body); line-height: 1.5; scroll-behavior: smooth; }
body { margin: 0; color: #1f2937; background: #ffffff; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
*, *::before, *::after { box-sizing: inherit; }
h1, h2, h3, h4, h5, h6 { font-family: var(--font-heading); margin-top: 0; font-weight: 700; line-height: 1.2; color: #111827; }
p { margin-top: 0; margin-bottom: 1rem; color: #4b5563; }
a { color: inherit; text-decoration: inherit; }
img, svg { display: block; max-width: 100%; height: auto; }
ul, ol { margin-top: 0; padding-left: 1.5rem; }

/* Layout Utilities */
.container { width: 100%; max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
.hidden { display: none; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.justify-center { justify-content: center; }
.gap-2 { gap: 0.5rem; } .gap-4 { gap: 1rem; } .gap-6 { gap: 1.5rem; } .gap-8 { gap: 2rem; } .gap-12 { gap: 3rem; }
.grid { display: grid; }
.grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
.grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 768px) {
  .md\\:hidden { display: none !important; }
  .md\\:grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
  .md\\:flex-col { flex-direction: column; }
}
@media (min-width: 769px) {
  .md\\:flex { display: flex; }
  .md\\:flex-row { flex-direction: row; }
  .md\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .md\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

/* Typography Utilities */
.text-sm { font-size: 0.875rem; }
.text-lg { font-size: 1.125rem; }
.text-xl { font-size: 1.25rem; }
.text-2xl { font-size: 1.5rem; }
.text-4xl { font-size: 2.25rem; }
.text-5xl { font-size: 3rem; }
.font-bold { font-weight: 700; }
.font-heading { font-family: var(--font-heading); }
.text-center { text-align: center; }
.mx-auto { margin-left: auto; margin-right: auto; }
.mb-2 { margin-bottom: 0.5rem; }
.mb-4 { margin-bottom: 1rem; }
.text-primary { color: var(--primary); }
.bg-primary { background-color: var(--primary); color: white; }
.text-white { color: #ffffff; }

/* Components */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.75rem 1.5rem; border-radius: var(--radius); font-weight: 600;
  transition: opacity 0.2s; cursor: pointer; text-decoration: none; border: none;
}
.btn:hover { opacity: 0.9; }
.btn-solid { background: var(--primary); color: white; }
.btn-outline { border: 2px solid var(--primary); color: var(--primary); background: transparent; }
.btn-ghost { background: transparent; color: var(--primary); }

/* Header & Footer */
.site-header { border-bottom: 1px solid #e5e7eb; padding: 1.5rem 0; position: sticky; top: 0; background: rgba(255,255,255,0.95); backdrop-filter: blur(8px); z-index: 50; }
.site-footer { border-top: 1px solid #e5e7eb; padding: 3rem 0; text-align: center; margin-top: auto; }
.nav-link { font-weight: 500; padding: 0.5rem; transition: color 0.2s; }
.nav-link:hover { color: var(--primary); }
.nav-link.active { color: var(--primary); }

/* Sections */
.section { padding: 5rem 0; }
.section-alt { background: #f9fafb; }
.section-title { font-size: 2.5rem; margin-bottom: 1rem; }
.section-subtitle { font-size: 1.25rem; color: #6b7280; max-width: 600px; margin-bottom: 3rem; }
.eyebrow { margin-bottom: 1rem; color: var(--primary); font-size: .78rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.hero { min-height: 620px; display: flex; align-items: center; overflow: hidden; }
.hero-frame { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(260px, .85fr); gap: 4rem; align-items: center; }
.hero-copy h1 { font-size: clamp(3rem, 7vw, 6.5rem); letter-spacing: -.055em; }
.hero-copy > p { max-width: 650px; font-size: 1.2rem; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 2rem; }
.hero-mark { aspect-ratio: 1; border-radius: var(--radius); display: grid; place-items: center; background: var(--primary); color: #fff; box-shadow: 24px 24px 0 rgba(15,23,42,.08); }
.hero-mark span { font-family: var(--font-heading); font-size: clamp(4rem, 10vw, 8rem); font-weight: 800; letter-spacing: -.1em; transform: translateX(-.08em); }
.hero-media { overflow: hidden; }
.hero-image { width: 100%; height: 100%; object-fit: cover; object-position: center; }
.brand-lockup { display: inline-flex; align-items: center; gap: .75rem; }
.brand-logo { max-width: 180px; max-height: 46px; object-fit: contain; object-position: left center; }
.brand-mark { width: 2.3rem; height: 2.3rem; display: inline-grid; place-items: center; border-radius: calc(var(--radius) * .8); background: var(--primary); color: #fff; font-family: var(--font-heading); font-size: .78rem; font-weight: 800; letter-spacing: .04em; box-shadow: 0 8px 18px color-mix(in srgb, var(--primary) 22%, transparent); }
.brand-name { line-height: 1; }
.about-media { flex: 1; width: 100%; min-height: 400px; overflow: hidden; border-radius: var(--radius); background: #f3f4f6; }
.about-image { width: 100%; height: 100%; min-height: 400px; object-fit: cover; object-position: center; }
.about-accent { width: 100%; min-height: 400px; border-radius: var(--radius); background: linear-gradient(145deg, color-mix(in srgb, var(--primary) 16%, white), #f8fafc); }
.gallery-card { overflow: hidden; padding: 0; min-height: 0; }
.gallery-image { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; object-position: center; }
.gallery-copy { padding: 1.4rem 1.5rem 1.5rem; }
.team-photo { width: 112px; height: 112px; margin: 0 auto 1.25rem; border-radius: 50%; object-fit: cover; object-position: center; border: 4px solid color-mix(in srgb, var(--primary) 14%, white); }

/* Cards */
.card { background: white; padding: 2rem; border-radius: var(--radius); border: 1px solid #e5e7eb; transition: transform 0.2s, box-shadow 0.2s; }
.card:hover { transform: translateY(-4px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); border-color: var(--primary); }

/* Forms */
.form-group { margin-bottom: 1.5rem; }
.form-label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
.form-input { width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: calc(var(--radius) * 0.5); font-family: inherit; }
.form-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(0,0,0,0.05); }
.form-status { margin: 1rem 0 0; padding: .75rem 1rem; border-radius: calc(var(--radius) * 0.5); background: color-mix(in srgb, var(--primary) 10%, white); color: #1f2937; }

/* Fixed template compositions */
.template-home-services .hero { background: #0f172a; }
.template-home-services .hero h1, .template-home-services .hero .eyebrow { color: #fff; }
.template-home-services .hero p { color: #cbd5e1; }
.template-home-services .hero-mark { background: linear-gradient(145deg, var(--primary), #fb923c); transform: rotate(3deg); }
.template-home-services .hero-image { object-position: 58% center; }
.template-home-services .site-header { border-top: 4px solid var(--primary); }

.template-advisor .site-header { border-top: 1px solid #111827; }
.template-advisor .hero { background: #f5f2eb; }
.template-advisor .hero-frame { grid-template-columns: minmax(0, 1.35fr) minmax(220px, .65fr); }
.template-advisor .hero-mark { border-radius: 50% 50% 4px 4px; background: #172554; box-shadow: 18px 18px 0 #d8d1c3; }
.template-advisor .hero-image { object-position: center 20%; }
.template-advisor .about-image { object-position: center 30%; }
.template-advisor .section-title { font-weight: 600; }

.template-cafe { background: #fffaf0; }
.template-cafe .site-header, .template-cafe .site-footer { background: #2b1b12; border-color: #4a3022; color: #fff; }
.template-cafe .site-header .nav-link, .template-cafe .site-footer p { color: #f4e7d3; }
.template-cafe .hero { background: #3a2418; }
.template-cafe .hero h1, .template-cafe .hero .eyebrow { color: #fff7ed; }
.template-cafe .hero p { color: #ead7bf; }
.template-cafe .hero-mark { border-radius: 999px 999px 32px 32px; background: #d97706; box-shadow: 18px 18px 0 #5b3824; }
.template-cafe .hero-image { object-position: center 58%; }
.template-cafe .gallery-image { aspect-ratio: 1 / 1; object-position: center; }
.template-cafe .card { border-color: #ead7bf; background: #fffaf0; }

.template-wellness .hero { background: #ecfdf5; }
.template-wellness .hero-frame { grid-template-columns: 1fr 1fr; }
.template-wellness .hero-mark { border-radius: 46% 54% 62% 38% / 42% 38% 62% 58%; background: linear-gradient(145deg, #34d399, #047857); box-shadow: 26px 18px 0 #d1fae5; }
.template-wellness .hero-image { object-position: center 25%; }
.template-wellness .team-photo { border-radius: 42% 58% 50% 50% / 48% 45% 55% 52%; }
.template-wellness .section-alt { background: #f0fdfa; }
.template-wellness .card { border: 0; box-shadow: 0 12px 40px rgba(5,150,105,.09); }

.template-creative .site-header { border: 0; border-bottom: 3px solid #111; }
.template-creative .hero { background: #f4f4f0; border-bottom: 3px solid #111; }
.template-creative .hero-frame { grid-template-columns: minmax(0, 1.45fr) minmax(220px, .55fr); }
.template-creative .hero h1 { text-transform: uppercase; line-height: .98; }
.template-creative .hero-mark { background: #111; border: 3px solid #111; box-shadow: 18px 18px 0 var(--primary); }
.template-creative .hero-image { object-position: 65% center; filter: grayscale(1); }
.template-creative .gallery-image { aspect-ratio: 3 / 4; }
.template-creative .card { border: 2px solid #111; box-shadow: 8px 8px 0 #111; }
.template-creative .card:hover { transform: translate(-2px,-2px); box-shadow: 11px 11px 0 var(--primary); }

.template-plumber .site-header { border-top: 4px solid var(--primary); }
.template-plumber .hero { background: #073a63; }
.template-plumber .hero h1, .template-plumber .hero .eyebrow { color: #f8fbff; }
.template-plumber .hero p { color: #c7e4fb; }
.template-plumber .hero-frame { grid-template-columns: minmax(0, 1.2fr) minmax(240px, .8fr); }
.template-plumber .hero-mark { border-radius: 44% 56% 48% 52% / 56% 42% 58% 44%; background: linear-gradient(145deg, #38bdf8, var(--primary)); box-shadow: 20px 20px 0 rgba(56,189,248,.22); }
.template-plumber .section-alt { background: #eff8ff; }
.template-plumber .card { border-color: #cfe7f8; }

.template-electrician { background: #fffbeb; }
.template-electrician .site-header { border-bottom: 3px solid #111827; }
.template-electrician .hero { background: #111827; }
.template-electrician .hero h1, .template-electrician .hero .eyebrow { color: #fff8df; }
.template-electrician .hero p { color: #fde68a; }
.template-electrician .hero-frame { grid-template-columns: minmax(0, .95fr) minmax(260px, 1.05fr); }
.template-electrician .hero-mark { border-radius: 8px; background: #f59e0b; color: #111827; box-shadow: 16px 16px 0 #fef3c7; transform: rotate(-3deg); }
.template-electrician .section-alt { background: #fff7d6; }
.template-electrician .card { border: 2px solid #111827; box-shadow: 5px 5px 0 #f59e0b; }
.template-electrician .card:hover { transform: translate(-2px,-2px); box-shadow: 8px 8px 0 #f59e0b; }

.template-carpenter { background: #fbf7f2; }
.template-carpenter .site-header, .template-carpenter .site-footer { background: #2a1b13; border-color: #493326; color: #fff8ef; }
.template-carpenter .site-header .nav-link, .template-carpenter .site-footer p { color: #eadbcb; }
.template-carpenter .hero { background: linear-gradient(135deg, #3d2518 0%, #2a1b13 58%, #70442c 100%); }
.template-carpenter .hero h1, .template-carpenter .hero .eyebrow { color: #fff8ef; }
.template-carpenter .hero p { color: #e8d4c0; }
.template-carpenter .hero-frame { grid-template-columns: minmax(0, 1.1fr) minmax(250px, .9fr); }
.template-carpenter .hero-mark { border-radius: 2px 34px 2px 34px; background: linear-gradient(145deg, #b98458, var(--primary)); box-shadow: 18px 18px 0 #6a412b; }
.template-carpenter .section-alt { background: #f1e7db; }
.template-carpenter .gallery-image { aspect-ratio: 1 / 1; }
.template-carpenter .card { border-color: #dbc4af; background: #fffaf5; }

/* Mobile Menu */
.mobile-menu { display: none; padding: 1rem; border-top: 1px solid #e5e7eb; background: white; position: absolute; width: 100%; left: 0; }
.mobile-menu.active { display: flex; flex-direction: column; gap: 1rem; }
.menu-btn { background: none; border: none; font-size: 1.5rem; cursor: pointer; display: none; }
@media (max-width: 768px) {
  .menu-btn { display: block; }
  .section { padding: 3rem 0; }
  .section-title { font-size: 2rem; }
  .hero { min-height: auto; }
  .hero-frame, .template-advisor .hero-frame, .template-wellness .hero-frame, .template-creative .hero-frame, .template-plumber .hero-frame, .template-electrician .hero-frame, .template-carpenter .hero-frame { grid-template-columns: 1fr; gap: 2.5rem; }
  .hero-copy h1 { font-size: clamp(2.7rem, 14vw, 4.5rem); }
  .hero-mark { max-width: 320px; width: 82%; margin: 0 auto; }
  .brand-logo { max-width: 140px; max-height: 38px; }
  .about-media, .about-accent, .about-image { min-height: 260px; }
  .gallery-image { aspect-ratio: 16 / 10; }
}

/* AI Chat Widget */
.sf-chat-widget { position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: var(--font-body); }
.sf-chat-button { width: 60px; height: 60px; border-radius: 50%; background: var(--primary); color: white; border: none; cursor: pointer; display: grid; place-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: transform 0.2s; }
.sf-chat-button:hover { transform: scale(1.05); }
.sf-chat-button svg { width: 28px; height: 28px; fill: currentColor; }
.sf-chat-panel { position: absolute; bottom: 80px; right: 0; width: 350px; height: 500px; max-height: calc(100vh - 100px); background: white; border-radius: var(--radius); box-shadow: 0 8px 30px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; opacity: 0; pointer-events: none; transform: translateY(10px); transition: all 0.2s ease-out; border: 1px solid #e5e7eb; }
.sf-chat-widget.active .sf-chat-panel { opacity: 1; pointer-events: auto; transform: translateY(0); }
.sf-chat-header { background: var(--primary); color: white; padding: 1rem; display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
.sf-chat-close { background: transparent; border: none; color: white; cursor: pointer; padding: 4px; display: grid; place-items: center; opacity: 0.8; }
.sf-chat-close:hover { opacity: 1; }
.sf-chat-messages { flex: 1; padding: 1rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; background: #f9fafb; }
.sf-chat-bubble { max-width: 85%; padding: 0.75rem 1rem; border-radius: 1rem; font-size: 0.9rem; line-height: 1.4; word-wrap: break-word; }
.sf-chat-bubble.assistant { background: white; border: 1px solid #e5e7eb; align-self: flex-start; border-bottom-left-radius: 0.25rem; color: #111827; }
.sf-chat-bubble.user { background: var(--primary); color: white; align-self: flex-end; border-bottom-right-radius: 0.25rem; }
.sf-chat-bubble.system { align-self: center; background: transparent; color: #6b7280; font-size: 0.75rem; font-style: italic; }
.sf-chat-input-area { padding: 1rem; border-top: 1px solid #e5e7eb; background: white; display: flex; gap: 0.5rem; }
.sf-chat-input { flex: 1; border: 1px solid #d1d5db; border-radius: calc(var(--radius) * 0.5); padding: 0.5rem 0.75rem; font-family: inherit; font-size: 0.9rem; outline: none; }
.sf-chat-input:focus { border-color: var(--primary); }
.sf-chat-send { background: var(--primary); color: white; border: none; border-radius: calc(var(--radius) * 0.5); padding: 0 1rem; font-weight: 600; cursor: pointer; }
.sf-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 480px) {
  .sf-chat-panel { position: fixed; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; transform: translateY(100%); }
  body.sf-chat-open { overflow: hidden; }
  .sf-chat-widget.active .sf-chat-button { display: none; }
}
`;
}

const getJs = (project: SiteProject) => `
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('mobile-menu-btn');
  const menu = document.getElementById('mobile-menu');
  if (btn && menu) {
    btn.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('active');
      btn.setAttribute('aria-expanded', String(isOpen));
    });
  }
  document.querySelectorAll('.contact-form').forEach((form) => {
    const sendButton = form.querySelector('.contact-submit');

    function sendContactMessage() {
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const recipient = form.getAttribute('data-recipient');
      if (!recipient) return;
      const status = form.querySelector('.form-status');

      if (document.documentElement.hasAttribute('data-siteforge-preview')) {
        if (status) {
          status.textContent = 'Thanks! This is a secure preview, so your message was not sent.';
          status.hidden = false;
        }
        form.reset();
        return;
      }

      const subject = encodeURIComponent('Website enquiry from ' + (data.get('name') || 'a visitor'));
      const body = encodeURIComponent(
        'Name: ' + (data.get('name') || '') + '\\n' +
        'Email: ' + (data.get('email') || '') + '\\n\\n' +
        (data.get('message') || '')
      );
      window.location.href = 'mailto:' + recipient + '?subject=' + subject + '&body=' + body;
    }

    if (sendButton) {
      sendButton.addEventListener('click', sendContactMessage);
    }
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        sendContactMessage();
      }
    });
  });
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

${project.receptionist?.enabled && project.receptionist?.receptionistId ? `
  // AI Chat Widget
  (function initChatWidget() {
    const receptionistId = ${JSON.stringify(project.receptionist.receptionistId)};
    const apiUrl = ${JSON.stringify(normalizeApiUrl(project.receptionist.hostedApiUrl))};
    function readChatSession(key) {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    }
    function writeChatSession(key, value) {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        // Sandboxed previews intentionally block storage. The active page can
        // still keep the session in memory and use the full chat experience.
      }
    }
    let sessionToken = readChatSession('sf_chat_session_' + receptionistId);
    let conversationId = readChatSession('sf_chat_conv_' + receptionistId);
    let escalationActive = readChatSession('sf_chat_escalated_' + receptionistId) === '1';
    let isOpen = false;
    let pollInterval = null;
    let isPolling = false;
    
    const widget = document.createElement('div');
    widget.className = 'sf-chat-widget';
    widget.innerHTML = \`
      <button class="sf-chat-button" aria-label="Open chat" type="button">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      </button>
      <div class="sf-chat-panel">
        <div class="sf-chat-header">
          <span class="sf-chat-assistant-name">Loading...</span>
          <button class="sf-chat-close" aria-label="Close chat" type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="sf-chat-messages" id="sf-chat-messages">
          <!-- messages inserted here -->
        </div>
        <div class="sf-chat-input-area" role="form">
          <input type="text" class="sf-chat-input" placeholder="Type a message..." required aria-label="Chat input" />
          <button type="button" class="sf-chat-send" aria-label="Send message">Send</button>
        </div>
      </div>
    \`;
    document.body.appendChild(widget);

    const btn = widget.querySelector('.sf-chat-button');
    const panel = widget.querySelector('.sf-chat-panel');
    const closeBtn = widget.querySelector('.sf-chat-close');
    const input = widget.querySelector('.sf-chat-input');
    const messages = widget.querySelector('#sf-chat-messages');
    const sendBtn = widget.querySelector('.sf-chat-send');
    const assistantNameEl = widget.querySelector('.sf-chat-assistant-name');

    let configFetched = false;
    let widgetConfig = null;
    let unavailableMessage = null;

    async function fetchConfig() {
      if (configFetched) return;
      try {
        const res = await fetch(apiUrl + '/widget/' + receptionistId + '/config', {
          credentials: 'omit'
        });
        if (!res.ok) throw new Error('Config failed');
        widgetConfig = await res.json();
        configFetched = true;
        assistantNameEl.textContent = widgetConfig.assistantName || 'Assistant';
        input.disabled = false;
        sendBtn.disabled = false;
        if (unavailableMessage) {
          unavailableMessage.remove();
          unavailableMessage = null;
        }
        
        // Add greeting if no messages yet
        if (!messages.children.length) {
          appendMessage('assistant', widgetConfig.greeting || 'Hi! How can I help you?');
        }
      } catch (e) {
        console.error('Failed to load widget config', e);
        assistantNameEl.textContent = 'Unavailable';
        input.disabled = true;
        sendBtn.disabled = true;
        if (!unavailableMessage) {
          unavailableMessage = appendMessage('system', 'Chat is currently unavailable.');
        }
      }
    }

    function toggleChat() {
      isOpen = !isOpen;
      widget.classList.toggle('active', isOpen);
      document.body.classList.toggle('sf-chat-open', isOpen);
      if (isOpen) {
        fetchConfig();
        input.focus();
        startPolling();
      } else {
        stopPolling();
      }
    }

    btn.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', toggleChat);

    function appendMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'sf-chat-bubble ' + role;
      div.textContent = content;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text) return;

      appendMessage('user', text);
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      try {
        const body = { message: text };
        if (sessionToken) body.sessionToken = sessionToken;
        
        const res = await fetch(apiUrl + '/widget/' + receptionistId + '/chat', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        if (!res.ok) throw new Error('Chat request failed');
        const data = await res.json();
        
        if (data.sessionToken) {
          sessionToken = data.sessionToken;
          writeChatSession('sf_chat_session_' + receptionistId, sessionToken);
        }
        if (data.conversationId) {
          conversationId = data.conversationId;
          writeChatSession('sf_chat_conv_' + receptionistId, conversationId);
        }

        appendMessage('assistant', data.reply);
        if (data.escalate) {
          escalationActive = true;
          writeChatSession('sf_chat_escalated_' + receptionistId, '1');
          appendMessage('system', 'This conversation has been escalated.');
        }
        startPolling(); // ensure polling is running after successful message
      } catch (err) {
        appendMessage('system', 'Failed to send message. Please try again.');
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    async function pollMessages() {
      if (!isOpen || !sessionToken || !conversationId || isPolling) return;
      isPolling = true;
      try {
        const res = await fetch(apiUrl + '/widget/' + receptionistId + '/conversations/' + conversationId + '/messages', {
          credentials: 'omit',
          headers: { 'X-SiteForge-Session-Token': sessionToken }
        });
        if (!res.ok) throw new Error('Poll failed');
        const data = await res.json();
        
        // Render safely using textContent
        messages.replaceChildren();
        data.messages.forEach(msg => {
          let r = msg.role === 'owner' ? 'assistant' : msg.role;
          if (r !== 'assistant' && r !== 'user' && r !== 'system') r = 'system';
          appendMessage(r, msg.content);
        });
        if (escalationActive) {
          appendMessage('system', 'This conversation has been escalated.');
        }
        
      } catch (err) {
        console.error('Polling error', err);
      } finally {
        isPolling = false;
      }
    }

    function startPolling() {
      if (!pollInterval && sessionToken && conversationId) {
        pollMessages();
        pollInterval = setInterval(pollMessages, 5000);
      }
    }
    function stopPolling() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }
  })();
` : ''}
});
`;

function buildNavigation(project: SiteProject, currentFilename: string): string {
  const links = Object.values(project.pages)
    .filter(p => Object.values(p.sections).length > 0) // only include pages that have content
    .map(p => {
      const filename = p.id === 'home' ? 'index.html' : `${p.id}.html`;
      const isActive = filename === currentFilename;
      return `<a href="${filename}" class="nav-link ${isActive ? 'active' : ''}">${escapeHtml(p.name)}</a>`;
    }).join('\n        ');

  const prospectContactTarget = project.pages.contact.sections.length > 0
    ? 'contact.html'
    : project.pages.home.sections.some(section => section.type === 'contact-form')
      ? 'index.html#contact'
      : null;
  const contactLink = project.prospectMeta?.isDraft
    ? prospectContactTarget
      ? `<a href="${prospectContactTarget}" class="btn btn-${project.designTokens.buttonStyle}">Contact Us</a>`
      : ''
    : `<a href="${project.pages.contact ? 'contact.html' : 'index.html#contact'}" class="btn btn-${project.designTokens.buttonStyle}">Contact Us</a>`;

  return `
    <nav class="hidden md:flex gap-6 items-center">
      ${links}
      ${contactLink}
    </nav>
  `;
}

function renderSection(sectionId: string, pageId: PageId, project: SiteProject, media: Record<string, MediaAsset>): string {
  const section = project.pages[pageId].sections.find(s => s.id === sectionId);
  if (!section) return '';

  const { type, title, subtitle, content, items } = section;
  const t = escapeHtml(title || '');
  const s = escapeHtml(subtitle || '');
  const c = escapeHtml(content || '');
  const businessInitials = escapeHtml(
    project.business.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(word => word[0])
      .join('')
      .toUpperCase() || 'SF'
  );
  const isProspectDraft = project.prospectMeta?.isDraft === true;
  const safeEmail = escapeHtml(
    isProspectDraft
      ? validEmailOrEmpty(project.business.email)
      : sanitizeEmail(project.business.email),
  );
  const phone = project.business.phone.trim();
  const phoneHref = phone.replace(/\D/g, '');
  const prospectContactTarget = project.pages.contact.sections.length > 0
    ? 'contact.html'
    : project.pages.home.sections.some(candidate => candidate.type === 'contact-form')
      ? 'index.html#contact'
      : null;

  switch (type) {
    case 'hero':
      const heroImage = mediaSource(section.image, media);
      const prospectEyebrow = [project.business.category, project.business.city]
        .map(value => value.trim())
        .filter(Boolean)
        .join(' · ');
      const prospectActions = [
        prospectContactTarget && c
          ? `<a href="${prospectContactTarget}" class="btn btn-${project.designTokens.buttonStyle}">${c}</a>`
          : '',
        phone
          ? `<a href="tel:${phoneHref}" class="btn btn-outline">${escapeHtml(phone)}</a>`
          : '',
      ].filter(Boolean).join('\n');
      return `
      <section class="section hero">
        <div class="container hero-frame">
          <div class="hero-copy">
            ${isProspectDraft
              ? prospectEyebrow ? `<div class="eyebrow">${escapeHtml(prospectEyebrow)}</div>` : ''
              : `<div class="eyebrow">${escapeHtml(project.business.category)} · ${escapeHtml(project.business.city)}</div>`}
            <h1>${t}</h1>
            ${isProspectDraft ? s ? `<p>${s}</p>` : '' : `<p>${s}</p>`}
            ${isProspectDraft
              ? prospectActions ? `<div class="hero-actions">${prospectActions}</div>` : ''
              : `<div class="hero-actions">
            <a href="contact.html" class="btn btn-${project.designTokens.buttonStyle}">${c || 'Get Started'}</a>
            <a href="tel:${project.business.phone.replace(/\D/g,'')}" class="btn btn-outline">${escapeHtml(project.business.phone)}</a>
            </div>`}
          </div>
          ${heroImage
            ? `<div class="hero-mark hero-media"><img class="hero-image" src="${heroImage}" alt="${escapeHtml(project.business.name)}" /></div>`
            : `<div class="hero-mark" aria-hidden="true"><span>${businessInitials}</span></div>`}
        </div>
      </section>`;
      
    case 'features':
    case 'services-list':
      return `
      <section class="section">
        <div class="container">
          ${t ? `<h2 class="section-title text-center">${t}</h2>` : ''}
          ${s ? `<p class="section-subtitle text-center mx-auto">${s}</p>` : ''}
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8" style="margin-top: 3rem;">
            ${(items || []).map(item => `
              <div class="card">
                <h3 class="text-xl mb-2">${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.description)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      </section>`;

    case 'about-text':
      const aboutImage = mediaSource(section.image, media);
      return `
      <section class="section">
        <div class="container flex flex-col md:flex-row gap-8 items-center">
          <div style="flex: 1;">
            <h2 class="section-title">${t}</h2>
            <div style="font-size: 1.125rem; line-height: 1.8;">${c}</div>
          </div>
          ${aboutImage
            ? `<div class="about-media"><img class="about-image" src="${aboutImage}" alt="${escapeHtml(t || project.business.name)}" /></div>`
            : '<div class="about-accent" aria-hidden="true"></div>'}
        </div>
      </section>`;

    case 'testimonials':
      return `
      <section class="section section-alt">
        <div class="container text-center">
          <h2 class="section-title">${t}</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8" style="margin-top: 3rem;">
            ${(items || []).map(item => `
              <div class="card" style="text-align: left;">
                <p style="font-size: 1.125rem; font-style: italic; margin-bottom: 1.5rem;">"${escapeHtml(item.description)}"</p>
                <div class="font-bold text-primary">— ${escapeHtml(item.title)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </section>`;

    case 'gallery': {
      const galleryItems = items && items.length > 0
        ? items
        : [
            { title: 'Featured project', description: 'A recent client transformation.' },
            { title: 'Behind the scenes', description: 'Careful work and attention to detail.' },
            { title: 'Local favourite', description: 'Built for the community we serve.' }
          ];
      return `
      <section class="section section-alt">
        <div class="container">
          <h2 class="section-title">${t}</h2>
          ${s ? `<p class="section-subtitle">${s}</p>` : ''}
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            ${galleryItems.map((item, index) => {
              const image = mediaSource(item.image, media);
              return `
              <article class="card gallery-card">
                ${image
                  ? `<img class="gallery-image" src="${image}" alt="${escapeHtml(item.title)}" loading="lazy" />`
                  : '<div class="gallery-image" aria-hidden="true" style="background: linear-gradient(145deg, color-mix(in srgb, var(--primary) 18%, white), #fff);"></div>'}
                <div class="gallery-copy">
                  <div class="eyebrow">0${index + 1}</div>
                  <h3 class="text-xl">${escapeHtml(item.title)}</h3>
                  <p>${escapeHtml(item.description)}</p>
                </div>
              </article>
            `}).join('')}
          </div>
        </div>
      </section>`;
    }

    case 'faq':
      return `
      <section class="section">
        <div class="container" style="max-width: 860px;">
          <h2 class="section-title">${t}</h2>
          <div style="margin-top: 2rem;">
            ${(items || []).map(item => `
              <details class="card" style="margin-bottom: 1rem;">
                <summary style="font-family: var(--font-heading); font-weight: 700; cursor: pointer;">${escapeHtml(item.title)}</summary>
                <p style="margin: 1rem 0 0;">${escapeHtml(item.description)}</p>
              </details>
            `).join('')}
          </div>
        </div>
      </section>`;

    case 'team':
      return `
      <section class="section section-alt">
        <div class="container">
          <h2 class="section-title text-center">${t}</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8" style="margin-top: 3rem;">
            ${(items || []).map((item, index) => {
              const photo = mediaSource(item.image, media);
              return `
              <article class="card text-center">
                ${photo
                  ? `<img class="team-photo" src="${photo}" alt="${escapeHtml(item.title)}" loading="lazy" />`
                  : `<div class="mx-auto" style="width: 84px; height: 84px; display: grid; place-items: center; border-radius: 50%; background: var(--primary); color: white; font-family: var(--font-heading); font-size: 1.5rem; font-weight: 800; margin-bottom: 1.25rem;">${escapeHtml(item.title.slice(0, 1))}${index + 1}</div>`}
                <h3 class="text-xl">${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.description)}</p>
              </article>
            `}).join('')}
          </div>
        </div>
      </section>`;

    case 'stats':
      return `
      <section class="section" style="background: var(--primary);">
        <div class="container">
          <h2 class="section-title text-center text-white">${t}</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            ${(items || []).map(item => `
              <div class="text-center">
                <div class="text-5xl font-bold text-white">${escapeHtml(item.title)}</div>
                <p style="color: rgba(255,255,255,.8);">${escapeHtml(item.description)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      </section>`;

    case 'contact-form':
      if (isProspectDraft) {
        const contactDetails = [
          phone
            ? `<div style="margin-bottom: 1rem;"><strong>Phone:</strong> <a href="tel:${phoneHref}" class="text-primary">${escapeHtml(phone)}</a></div>`
            : '',
          safeEmail
            ? `<div style="margin-bottom: 1rem;"><strong>Email:</strong> <a href="mailto:${safeEmail}" class="text-primary">${safeEmail}</a></div>`
            : '',
          project.business.city.trim()
            ? `<div style="margin-bottom: 1rem;"><strong>Location:</strong> ${escapeHtml(project.business.city.trim())}</div>`
            : '',
        ].filter(Boolean).join('\n');
        const emailForm = safeEmail
          ? `<div style="flex: 1;" class="card">
               <form class="contact-form" data-recipient="${safeEmail}">
                <div class="form-group">
                   <label class="form-label" for="contact-name">Name</label>
                   <input id="contact-name" type="text" name="name" autocomplete="name" required class="form-input" />
                </div>
                <div class="form-group">
                   <label class="form-label" for="contact-email">Email</label>
                   <input id="contact-email" type="email" name="email" autocomplete="email" required class="form-input" />
                </div>
                <div class="form-group">
                   <label class="form-label" for="contact-message">Message</label>
                   <textarea id="contact-message" name="message" rows="4" required class="form-input"></textarea>
                </div>
                <button type="button" class="contact-submit btn btn-${project.designTokens.buttonStyle}" style="width: 100%;">Send Message</button>
                <p class="form-status" role="status" aria-live="polite" hidden></p>
              </form>
            </div>`
          : '';
        return `
      <section id="contact" class="section">
        <div class="container">
          <div class="flex flex-col md:flex-row gap-12">
            <div style="flex: 1;">
              <h2 class="section-title">${t}</h2>
              ${s ? `<p class="section-subtitle">${s}</p>` : ''}
              ${contactDetails ? `<div style="margin-top: 2rem;">${contactDetails}</div>` : ''}
            </div>
            ${emailForm}
          </div>
        </div>
      </section>`;
      }
      return `
      <section id="contact" class="section">
        <div class="container">
          <div class="flex flex-col md:flex-row gap-12">
            <div style="flex: 1;">
              <h2 class="section-title">${t}</h2>
              <p class="section-subtitle">${s}</p>
              
              <div style="margin-top: 2rem;">
                <div style="margin-bottom: 1rem;"><strong>Phone:</strong> <a href="tel:${project.business.phone.replace(/\D/g,'')}" class="text-primary">${escapeHtml(project.business.phone)}</a></div>
                 <div style="margin-bottom: 1rem;"><strong>Email:</strong> <a href="mailto:${safeEmail}" class="text-primary">${safeEmail}</a></div>
                <div style="margin-bottom: 1rem;"><strong>Location:</strong> ${escapeHtml(project.business.city)}</div>
              </div>
            </div>
            <div style="flex: 1;" class="card">
               <!-- This opens the visitor's email app. Replace the submit handler with your preferred form processor if needed. -->
               <form class="contact-form" data-recipient="${safeEmail}">
                <div class="form-group">
                   <label class="form-label" for="contact-name">Name</label>
                   <input id="contact-name" type="text" name="name" autocomplete="name" required class="form-input" />
                </div>
                <div class="form-group">
                   <label class="form-label" for="contact-email">Email</label>
                   <input id="contact-email" type="email" name="email" autocomplete="email" required class="form-input" />
                </div>
                <div class="form-group">
                   <label class="form-label" for="contact-message">Message</label>
                   <textarea id="contact-message" name="message" rows="4" required class="form-input"></textarea>
                </div>
                 <button type="button" class="contact-submit btn btn-${project.designTokens.buttonStyle}" style="width: 100%;">Send Message</button>
                 <p class="form-status" role="status" aria-live="polite" hidden></p>
              </form>
            </div>
          </div>
        </div>
      </section>`;

    default:
      return `<section class="section"><div class="container"><h2 class="section-title">${t}</h2></div></section>`;
  }
}

export function isAllowedHostedApiUrl(url?: string): boolean {
  if (!url?.trim()) return true;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '/api') return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hasAbsoluteHostedApiUrl(url?: string): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeApiUrl(url?: string): string {
  if (!hasAbsoluteHostedApiUrl(url)) return '/api';
  const trimmed = url!.trim().replace(/\/+$/, '');
  return /\/api$/i.test(trimmed) ? trimmed : `${trimmed}/api`;
}

export function generateSite(project: SiteProject): GeneratedSite {
  const result: GeneratedSite = {
    pages: {},
    css: generateCss(project),
    js: getJs(project),
    media: {}
  };

  Object.values(project.pages).forEach(page => {
    // Only generate pages that are supported/have sections
    const order = project.sectionOrder[page.id] || [];
    if (order.length === 0 && page.id !== 'home') return; // Skip empty pages, except home

    const hidden = project.hiddenSections[page.id] || [];
    const visibleSections = order.filter(id => !hidden.includes(id));
    
    const filename = page.id === 'home' ? 'index.html' : `${page.id}.html`;
    const nav = buildNavigation(project, filename);
    const sectionsHtml = visibleSections.map(sid => renderSection(sid, page.id, project, result.media)).join('\n');
    const logo = mediaSource(project.business.logo, result.media);
    const fallbackLogoInitials =
      project.business.name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0])
        .join('')
        .toUpperCase() || 'SF';
    const brandLockup = logo
      ? `<img class="brand-logo" src="${logo}" alt="${escapeHtml(project.business.name)} logo" />`
      : `<span class="brand-mark" aria-hidden="true">${escapeHtml(fallbackLogoInitials)}</span><span class="brand-name">${escapeHtml(project.business.name)}</span>`;

    result.pages[filename] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.business.name)} | ${escapeHtml(page.name)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body class="template-${project.templateId} flex flex-col" style="min-height: 100vh;">
  <header class="site-header">
    <div class="container flex justify-between items-center">
      <a href="index.html" class="brand-lockup text-2xl font-bold font-heading text-primary">${brandLockup}</a>
      ${nav}
      <button id="mobile-menu-btn" class="menu-btn" type="button" aria-label="Toggle menu" aria-controls="mobile-menu" aria-expanded="false">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
      </button>
    </div>
    <div id="mobile-menu" class="mobile-menu">
      ${Object.values(project.pages).filter(p => Object.values(p.sections).length > 0).map(p => {
        const fn = p.id === 'home' ? 'index.html' : `${p.id}.html`;
        return `<a href="${fn}" class="nav-link">${escapeHtml(p.name)}</a>`;
      }).join('\n      ')}
    </div>
  </header>

  <main style="flex: 1;">
    ${sectionsHtml}
  </main>

  <footer class="site-footer">
    <div class="container text-sm" style="color: #6b7280;">
      <div class="text-xl font-bold text-primary mb-4">${escapeHtml(project.business.name)}</div>
      ${project.prospectMeta?.isDraft
        ? [project.business.category, project.business.city].map(value => value.trim()).filter(Boolean).length > 0
          ? `<p>${escapeHtml([project.business.category, project.business.city].map(value => value.trim()).filter(Boolean).join(' · '))}</p>`
          : ''
        : `<p>${escapeHtml(project.business.category)} in ${escapeHtml(project.business.city)}</p>`}
      <p style="margin-top: 1.5rem;">© <span id="year"></span> ${escapeHtml(project.business.name)}. All rights reserved.</p>
    </div>
  </footer>
  <script src="main.js"></script>
</body>
</html>`;
  });

  return result;
}

const isSafeMediaAsset = (asset: MediaAsset | undefined): asset is MediaAsset =>
  Boolean(
    asset
      && supportedMediaTypes.has(asset.mimeType)
      && /^[a-zA-Z0-9_-]+$/.test(asset.id)
      && /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+$/.test(asset.dataUrl)
  );

const mediaFilename = (asset: MediaAsset) => {
  const cleanName = asset.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'image';
  const extension = asset.mimeType.split('/')[1].replace('jpeg', 'jpg');
  return `${asset.id}-${cleanName}.${extension}`;
};

const mediaSource = (asset: MediaAsset | undefined, media: Record<string, MediaAsset>) => {
  if (!isSafeMediaAsset(asset)) return '';
  const filename = mediaFilename(asset);
  media[filename] = asset;
  return `assets/${filename}`;
};
