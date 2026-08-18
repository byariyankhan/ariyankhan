/* Auto-rotating single review card — fades to the next review every
   few seconds with dot indicators showing position, so it's clear
   there's more than one without needing a click. Dots are also
   clickable for manual browsing, and rotation pauses on hover/focus
   and is skipped entirely for prefers-reduced-motion. Combines
   curated quotes (data-curated="key1,key2,..." into the shared
   window.CURATED_REVIEWS map from js/reviews-data.js — one key per
   service page, or several on index.html for a mixed feed) with
   self-submitted reviews fetched live from reviews.php. Built with
   createElement/textContent throughout — never innerHTML — since
   review text is user-submitted. */
(() => {
  const root = document.getElementById('reviewCard');
  if (!root) return;

  const faceEl = document.getElementById('reviewCardFace');
  const dotsEl = document.getElementById('reviewCardDots');
  if (!faceEl || !dotsEl) return;

  const reviewSource = window.CURATED_REVIEWS || {};
  const curatedKeys = (root.dataset.curated || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const curated = curatedKeys.flatMap((key) => reviewSource[key] || []);
  const shouldShuffle = root.dataset.shuffle === 'true';

  function shuffle(list) {
    const shuffled = list.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  const ROTATE_MS = 5000;
  const FADE_MS = 350;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let reviews = [];
  let index = 0;
  let timer = null;

  // The avatar ring lives outside the fading face — it stays put across
  // rotations (only the initial inside it changes) so the corner never
  // goes blank mid-fade.
  const avatarEl = document.createElement('span');
  avatarEl.className = 'review-card-avatar';
  avatarEl.setAttribute('aria-hidden', 'true');
  root.insertBefore(avatarEl, faceEl);

  function renderFace(review) {
    faceEl.innerHTML = '';

    avatarEl.textContent = (review.name || '?').trim().charAt(0).toUpperCase();

    const name = document.createElement('h3');
    name.className = 'review-card-name';
    name.textContent = review.name;

    const quote = document.createElement('p');
    quote.className = 'review-card-quote';
    quote.textContent = review.body;

    const stars = document.createElement('div');
    stars.className = 'review-card-stars';
    stars.setAttribute('aria-label', `${review.rating} out of 5 stars`);
    for (let i = 0; i < review.rating; i++) {
      const star = document.createElement('span');
      star.textContent = '★';
      stars.appendChild(star);
    }

    const body = document.createElement('div');
    body.className = 'review-card-body';
    body.append(quote, stars);

    faceEl.append(name, body);
  }

  function renderDots() {
    dotsEl.innerHTML = '';
    reviews.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'review-card-dot' + (i === index ? ' is-active' : '');
      dot.setAttribute('aria-label', `Show review ${i + 1} of ${reviews.length}`);
      dot.addEventListener('click', () => goTo(i));
      dotsEl.appendChild(dot);
    });
  }

  function goTo(newIndex) {
    if (newIndex === index) return;
    faceEl.classList.add('is-fading');
    window.setTimeout(() => {
      index = newIndex;
      renderFace(reviews[index]);
      renderDots();
      faceEl.classList.remove('is-fading');
    }, FADE_MS);
  }

  function next() {
    goTo((index + 1) % reviews.length);
  }

  function startTimer() {
    stopTimer();
    if (!reduceMotion && reviews.length > 1) {
      timer = window.setInterval(next, ROTATE_MS);
    }
  }

  function stopTimer() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  root.addEventListener('mouseenter', stopTimer);
  root.addEventListener('mouseleave', startTimer);
  root.addEventListener('focusin', stopTimer);
  root.addEventListener('focusout', startTimer);

  function init(list) {
    reviews = shouldShuffle ? shuffle(list) : list;
    if (!reviews.length) return;
    renderFace(reviews[0]);
    renderDots();
    root.setAttribute('aria-busy', 'false');
    startTimer();
  }

  const api = root.dataset.api || 'reviews.php';
  fetch(api)
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      const submitted = json && json.ok && Array.isArray(json.reviews) ? json.reviews : [];
      init([...curated, ...submitted]);
    })
    .catch(() => init(curated));
})();
