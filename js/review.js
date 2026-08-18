(() => {
  const form = document.getElementById('reviewForm');
  const errorEl = document.getElementById('reviewError');
  const successEl = document.getElementById('reviewSuccess');
  const submitBtn = document.getElementById('reviewSubmit');

  if (!form) return;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    successEl.hidden = true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = form.name.value.trim();
    const email = form.email.value.trim();
    const code = form.code.value.trim();
    const review = form.review.value.trim();
    const ratingInput = form.querySelector('input[name="rating"]:checked');

    if (!name || !email || !code || !review) {
      showError('Please fill in every field.');
      return;
    }
    if (!ratingInput) {
      showError('Please choose a star rating.');
      return;
    }

    errorEl.hidden = true;
    successEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('reviews.php', {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          name,
          email,
          code,
          rating: Number(ratingInput.value),
          review,
        }),
      });

      clearTimeout(timeout);
      const json = await response.json();

      if (!response.ok || !json.ok) {
        showError(json.error || 'Something went wrong. Please try again.');
        return;
      }

      form.hidden = true;
      successEl.hidden = false;
    } catch (err) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Review';
    }
  });
})();
