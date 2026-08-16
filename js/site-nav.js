(() => {
  const NAV_ITEMS = [
    { id: 'home', label: 'Home', number: '01' },
    { id: 'services', label: 'Services', number: '02' },
    { id: 'stages', label: 'Editing Stages', number: '03' },
    { id: 'work', label: 'Recent Work', number: '04' },
    { id: 'faq', label: 'FAQ', number: '05' },
    { id: 'contact', label: 'Contact', number: '06' },
  ];

  function escapeAttr(value) {
    return String(value).replace(/"/g, '&quot;');
  }

  // On the homepage, links are anchor scrolls (#services).
  // On subpages, links go back to the homepage first (index.html#services).
  function buildHref(itemId, isHomePage, homePath) {
    if (isHomePage) return itemId === 'home' ? '#home' : `#${itemId}`;
    return itemId === 'home' ? homePath : `${homePath}#${itemId}`;
  }

  function buildNavComponent(isHomePage, homePath) {
    const logoHref = isHomePage ? '#home' : homePath;
    const contactHref = buildHref('contact', isHomePage, homePath);
    const basePath = homePath.replace(/index\.html$/, '');

    const desktopLinks = NAV_ITEMS.map(item =>
      `<a href="${escapeAttr(buildHref(item.id, isHomePage, homePath))}" class="nav-link">${item.label}</a>`
    ).join('\n');

    const mobileLinks = NAV_ITEMS.map(item =>
      `<a href="${escapeAttr(buildHref(item.id, isHomePage, homePath))}" class="menu-link"><span class="ml-num">${item.number}</span><span class="ml-label">${item.label}</span></a>`
    ).join('\n');

    return `
<nav class="site-nav">
  <a href="${escapeAttr(logoHref)}" class="nav-logo">
    <div class="logo-mark"><img src="${escapeAttr(basePath)}images/logo-avatar.webp" alt="" width="34" height="34" decoding="async"></div>
    <span class="logo-text">ARIYAN <span>KHAN</span></span>
  </a>

  <div class="nav-links">
    ${desktopLinks}
  </div>
  <a href="${escapeAttr(contactHref)}" class="nav-cta-desk">Work With Me</a>

  <button class="menu-btn" id="menuBtn" type="button" aria-controls="menuOverlay" aria-expanded="false" aria-label="Open navigation menu">
    <span class="menu-icon-bar bar1"></span>
    <span class="menu-icon-bar bar2"></span>
    <span class="menu-icon-bar bar3"></span>
  </button>
</nav>

<div class="menu-overlay" id="menuOverlay" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Navigation menu">
  <div class="menu-overlay-inner">
    <nav class="menu-links" aria-label="Main navigation">
      ${mobileLinks}
    </nav>
    <a href="${escapeAttr(contactHref)}" class="menu-cta">
      <span class="tc-play">&#9658;</span> Start a Project
    </a>
  </div>
</div>`.trim();
  }

  class SiteNav extends HTMLElement {
    connectedCallback() {
      if (this.dataset.rendered === 'true') return;

      const isHomePage = this.dataset.page === 'home';
      const homePath = this.dataset.homePath || 'index.html';

      this.style.display = 'contents';
      this.innerHTML = buildNavComponent(isHomePage, homePath);
      this.dataset.rendered = 'true';
    }
  }

  if (!customElements.get('site-nav')) {
    customElements.define('site-nav', SiteNav);
  }
})();
