(() => {
  /* ── Category → service page, so the footer always points at the right one of the 4 ── */
  const SERVICE_MAP = {
    documentary: { label: 'Documentary Editing Service', href: '../documentary-video-editing.html' },
    talking: { label: 'Talking Head Editing Service', href: '../talking-head-video-editing.html' },
    editing: { label: 'Talking Head Editing Service', href: '../talking-head-video-editing.html' },
    maps: { label: 'Map Animation Service', href: '../map-animation-video-editing.html' },
  };

  function initServiceLink() {
    const category = document.querySelector('[data-category]')?.dataset.category;
    const service = SERVICE_MAP[category];
    if (!service) return;

    document.querySelectorAll('[data-service-link]').forEach(link => {
      link.href = service.href;

      const label = link.querySelector('[data-service-label]');
      if (label) label.textContent = service.label;
    });
  }

  /* ── Related articles, pulled live from the blog listing page ── */
  async function initRelatedArticles() {
    const list = document.querySelector('[data-related-articles]');
    const wrap = list?.closest('.article-related');
    if (!list || !wrap) return;

    const currentFile = window.location.pathname.split('/').pop();
    const currentCategory = document.querySelector('[data-category]')?.dataset.category;

    try {
      const res = await fetch('/blog/');
      if (!res.ok) throw new Error('fetch failed');

      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const items = [...doc.querySelectorAll('.blog-article-card')]
        .map(card => {
          const href = card.querySelector('.blog-text-link')?.getAttribute('href');
          if (!href || href === currentFile) return null;
          return {
            href,
            title: card.querySelector('h3 a')?.textContent.trim(),
            category: card.dataset.category,
          };
        })
        .filter(Boolean);

      if (!items.length) throw new Error('no related items');

      items.sort((a, b) => (a.category === currentCategory ? -1 : 1) - (b.category === currentCategory ? -1 : 1));

      list.innerHTML = items
        .slice(0, 2)
        .map(
          item => `
            <a class="article-related-item" href="${item.href}">
              <span>${item.title}</span>
              <span aria-hidden="true">&rarr;</span>
            </a>`
        )
        .join('');
    } catch {
      wrap.remove();
    }
  }

  /* ── Reading progress (playhead) ── */
  function initReadingProgress() {
    const bar = document.querySelector('[data-article-progress]');
    const body = document.querySelector('[data-article-body]');
    if (!bar || !body) return;

    function update() {
      const start = body.offsetTop;
      const total = body.offsetHeight;
      const scrolled = window.scrollY - start + window.innerHeight * 0.5;
      const pct = Math.min(100, Math.max(0, (scrolled / total) * 100));
      bar.style.width = pct + '%';
    }

    document.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ── Reading time, computed from word count ── */
  function initReadingTime() {
    const articleBody = document.querySelector('[data-article-body]');
    const output = document.querySelector('[data-reading-time]');
    if (!articleBody || !output) return;

    const words = articleBody.textContent.trim().split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.ceil(words / 220));
    output.textContent = `${minutes} MIN READ`;
  }

  /* ── Share links ── */
  function getShareUrl() {
    return document.querySelector('link[rel="canonical"]')?.href || window.location.href.split('#')[0];
  }

  function initShareLinks() {
    const articleUrl = getShareUrl();
    const articleTitle =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title;

    const linkedIn = document.querySelector('[data-share-linkedin]');
    const x = document.querySelector('[data-share-x]');

    if (linkedIn) {
      linkedIn.href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(articleUrl)}`;
      linkedIn.target = '_blank';
      linkedIn.rel = 'noopener noreferrer';
    }

    if (x) {
      x.href = `https://x.com/intent/tweet?url=${encodeURIComponent(articleUrl)}&text=${encodeURIComponent(articleTitle)}`;
      x.target = '_blank';
      x.rel = 'noopener noreferrer';
    }
  }

  /* ── Copy link ── */
  function initCopyLink() {
    const copyButton = document.querySelector('[data-copy-link]');
    if (!copyButton) return;

    const defaultLabel = copyButton.textContent;

    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getShareUrl());
        copyButton.textContent = 'Copied';
        copyButton.classList.add('is-copied');

        window.setTimeout(() => {
          copyButton.textContent = defaultLabel;
          copyButton.classList.remove('is-copied');
        }, 1600);
      } catch {
        copyButton.textContent = 'Copy failed';
      }
    });
  }

  initReadingProgress();
  initReadingTime();
  initShareLinks();
  initCopyLink();
  initServiceLink();
  initRelatedArticles();
})();
