(() => {
  const NAV_ITEMS = [
    { id: 'home', label: 'Home', number: '01', type: 'anchor' },
    { id: 'services', label: 'Services', number: '02', type: 'anchor' },
    { id: 'stages', label: 'Editing Stages', number: '03', type: 'anchor' },
    { id: 'work', label: 'Recent Work', number: '04', type: 'anchor' },
    { id: 'faq', label: 'FAQ', number: '05', type: 'anchor' },
    { id: 'reviews', label: 'Reviews', number: '06', type: 'anchor' },
    { id: 'contact', label: 'Contact', number: '07', type: 'anchor' },
  ];

  function escapeAttr(value) {
    return String(value).replace(/"/g, '&quot;');
  }

  // Owns the mobile menu button/overlay this component just rendered — kept
  // here (not in main.js) so pages that skip main.js still get a working
  // menu button.
  function initMenu(root) {
    const menuBtn = root.querySelector('#menuBtn');
    const menuOverlay = root.querySelector('#menuOverlay');
    const menuNav = root.querySelector('.site-nav');
    if (!menuBtn || !menuOverlay || !menuNav) return;

    function syncMenuOverlayOffset() {
      menuOverlay.style.setProperty('--menu-offset', `${Math.ceil(menuNav.getBoundingClientRect().height)}px`);
    }

    function setMenuState(isOpen) {
      menuBtn.classList.toggle('open', isOpen);
      menuOverlay.classList.toggle('open', isOpen);
      menuBtn.setAttribute('aria-expanded', String(isOpen));
      menuBtn.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
      menuOverlay.setAttribute('aria-hidden', String(!isOpen));
      document.body.classList.toggle('menu-open', isOpen);

      if (isOpen) {
        syncMenuOverlayOffset();
        // Move focus into the menu so keyboard/screen-reader users can navigate it.
        requestAnimationFrame(() => {
          menuOverlay.scrollTop = 0;
          menuOverlay.querySelector('.menu-link')?.focus();
        });
      } else {
        // Restore focus to the button that opened the menu.
        menuBtn.focus();
      }
    }

    function closeMenu() {
      setMenuState(false);
    }

    syncMenuOverlayOffset();
    menuBtn.addEventListener('click', () => setMenuState(!menuOverlay.classList.contains('open')));

    menuOverlay.querySelectorAll('.menu-link, .menu-cta').forEach(link => {
      link.addEventListener('click', closeMenu);
    });

    // Only recalculate offset on mobile where the overlay is visible.
    window.addEventListener('resize', () => {
      if (window.innerWidth < 1024) syncMenuOverlayOffset();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  // Anchor items scroll on the homepage (#services) or jump back to the
  // homepage first on subpages (index.html#services). Page items always
  // point at their own page, resolved relative to the site root.
  function buildHref(item, isHomePage, homePath, basePath) {
    if (item.type === 'page') {
      return `${basePath}${item.path}`;
    }
    if (isHomePage) return item.id === 'home' ? '#home' : `#${item.id}`;
    return item.id === 'home' ? homePath : `${homePath}#${item.id}`;
  }

  function buildNavComponent(isHomePage, homePath) {
    const basePath = homePath.replace(/index\.html$/, '');
    const logoHref = isHomePage ? '#home' : homePath;
    const contactItem = NAV_ITEMS.find(item => item.id === 'contact');
    const contactHref = buildHref(contactItem, isHomePage, homePath, basePath);

    const desktopLinks = NAV_ITEMS.map(item =>
      `<a href="${escapeAttr(buildHref(item, isHomePage, homePath, basePath))}" class="nav-link">${item.label}</a>`
    ).join('\n');

    const mobileLinks = NAV_ITEMS.map(item =>
      `<a href="${escapeAttr(buildHref(item, isHomePage, homePath, basePath))}" class="menu-link"><span class="ml-num">${item.number}</span><span class="ml-label">${item.label}</span></a>`
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
      initMenu(this);
    }
  }

  if (!customElements.get('site-nav')) {
    customElements.define('site-nav', SiteNav);
  }
})();
