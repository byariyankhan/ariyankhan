(() => {
  /* ── Typewriter ── */
  const typedEl = document.querySelector('[data-typewriter]');
  const WORDS = ['editing', 'storytelling', 'pacing', 'color', 'sound design'];

  if (typedEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let wordIndex = 0;
    const TYPE_HOLD = 1800;
    const SWAP_OUT = 170;

    function nextWord() {
      typedEl.classList.add('is-changing');
      setTimeout(() => {
        wordIndex = (wordIndex + 1) % WORDS.length;
        typedEl.textContent = WORDS[wordIndex];
        typedEl.classList.remove('is-changing');
      }, SWAP_OUT);
    }

    typedEl.textContent = WORDS[0];
    setInterval(nextWord, TYPE_HOLD);
  }

  /* ── Stat count-up ── */
  const statEls = document.querySelectorAll('[data-count]');

  if (statEls.length) {
    const statObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        statObserver.unobserve(el);

        const target = parseInt(el.dataset.count, 10) || 0;
        const duration = 900;
        const start = performance.now();

        function tick(now) {
          const progress = Math.min((now - start) / duration, 1);
          el.textContent = String(Math.round(target * progress)).padStart(2, '0');
          if (progress < 1) requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
      });
    }, { threshold: 0.4 });

    statEls.forEach(el => statObserver.observe(el));
  }

  /* ── Scroll reveal ── */
  const revealEls = document.querySelectorAll('.blog-reveal');

  if (revealEls.length) {
    const revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.15 });

    revealEls.forEach(el => revealObserver.observe(el));
  }

  /* ── Category filtering ── */
  const grid = document.querySelector('[data-article-grid]');
  const filterBtns = document.querySelectorAll('[data-filter]');
  const latestSection = document.querySelector('.blog-latest');
  const toggleBtn = document.querySelector('[data-article-toggle]');
  const maxArticles = grid ? parseInt(grid.dataset.maxArticles, 10) || Infinity : Infinity;

  function applyLimit() {
    if (!grid) return;
    const visibleCards = [...grid.querySelectorAll('.blog-article-card')].filter(
      card => !card.classList.contains('is-filtered')
    );

    grid.querySelectorAll('.blog-article-card').forEach(card => card.classList.remove('is-over-limit'));
    visibleCards.slice(maxArticles).forEach(card => card.classList.add('is-over-limit'));

    if (toggleBtn) {
      const hasOverflow = visibleCards.length > maxArticles;
      toggleBtn.hidden = !hasOverflow;
      if (!hasOverflow) latestSection?.classList.remove('is-expanded');
    }
  }

  function setFilter(filter) {
    if (!grid) return;

    grid.querySelectorAll('.blog-article-card').forEach(card => {
      const matches = filter === 'all' || card.dataset.category === filter;
      card.classList.toggle('is-filtered', !matches);
    });

    filterBtns.forEach(btn => {
      const isSelected = btn.dataset.filter === filter;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    });

    latestSection?.classList.remove('is-expanded');
    applyLimit();
  }

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const expanded = latestSection?.classList.toggle('is-expanded');
      toggleBtn.setAttribute('aria-expanded', String(!!expanded));
      const label = toggleBtn.querySelector('[data-toggle-text]');
      if (label) label.textContent = expanded ? 'Show fewer articles' : 'View all articles';
    });
  }

  applyLimit();

  /* ── Hero topic links jump to the matching filter ── */
  document.querySelectorAll('[data-topic-filter]').forEach(link => {
    link.addEventListener('click', () => setFilter(link.dataset.topicFilter));
  });

  /* ── Reading time per card, fetched from the article's own word count ── */
  document.querySelectorAll('.blog-article-card').forEach(card => {
    const badge = card.querySelector('[data-card-reading-time]');
    const link = card.querySelector('.blog-article-image');
    if (!badge || !link?.href) return;

    fetch(link.href)
      .then(res => (res.ok ? res.text() : Promise.reject()))
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.querySelector('[data-article-body]');
        if (!body) return;

        const words = body.textContent.trim().split(/\s+/).filter(Boolean).length;
        const minutes = Math.max(1, Math.ceil(words / 220));
        badge.textContent = `${minutes} MIN READ`;
      })
      .catch(() => badge.remove());
  });
})();
