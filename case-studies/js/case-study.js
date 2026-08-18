(() => {
  /* Only 2 case studies exist so far — related links and the CTA
     destination are just written directly into each page's HTML
     instead of derived/fetched, unlike the blog's article.js. This
     file only handles the behavior that's genuinely dynamic. */

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
})();
