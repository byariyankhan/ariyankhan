(() => {
  const form = document.getElementById('trackerForm');
  const codeInput = document.getElementById('trackerCode');
  const submitBtn = document.getElementById('trackerSubmit');
  const errorEl = document.getElementById('trackerError');
  const resultEl = document.getElementById('trackerResult');
  const labelEl = document.getElementById('trackerProjectLabel');
  const stagesEl = document.getElementById('trackerStages');

  // Index into the fixed TRACKER_STAGES list (lib/tracker-db.php) that
  // "Payment (Advance)" and "Payment (Full)" live at — used to attach a
  // $ amount straight onto that stage's label instead of a separate note.
  const ADVANCE_STAGE_INDEX = 1;
  const FULL_PAYMENT_STAGE_INDEX = 4;

  function formatMoney(amount) {
    const rounded = Math.round(amount * 100) / 100;
    return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
  }

  // "$240 received" under Payment (Advance), "$160 due" (or "Paid in
  // full") under Payment (Full) — only when there's a price on file.
  function stagePaymentNote(stageIndex, priceAmount, advanceAmount) {
    if (priceAmount <= 0) return '';
    if (stageIndex === ADVANCE_STAGE_INDEX) {
      return advanceAmount > 0 ? `${formatMoney(advanceAmount)} received` : '';
    }
    if (stageIndex === FULL_PAYMENT_STAGE_INDEX) {
      const due = priceAmount - advanceAmount;
      return due > 0 ? `${formatMoney(due)} due` : 'Paid in full';
    }
    return '';
  }

  if (!form) return;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    resultEl.hidden = true;
  }

  function formatDate(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
    if (!match) return '';
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderStages(stages, currentStage, createdAt, deliveryDate, stageDates, priceAmount, advanceAmount) {
    stagesEl.innerHTML = '';
    const lastIndex = stages.length - 1;
    const dates = stageDates && typeof stageDates === 'object' ? stageDates : {};

    stages.forEach((stage, index) => {
      const state = index < currentStage ? 'done' : index === currentStage ? 'current' : 'upcoming';

      const step = document.createElement('div');
      step.className = `hstep hstep--${state}`;

      const dateSlot = document.createElement('div');
      dateSlot.className = 'hstep-date-slot';
      // Prefer the actual date this stage was marked; fall back to the
      // project's creation date on the first stage and the admin-picked
      // expected delivery date on the last, for stages never explicitly dated.
      let dateLabel = formatDate(dates[index]);
      if (!dateLabel && index === 0) dateLabel = formatDate(createdAt);
      if (!dateLabel && index === lastIndex) dateLabel = formatDate(deliveryDate);
      if (dateLabel) {
        const dateText = document.createElement('span');
        dateText.className = 'hstep-date-text';
        dateText.textContent = dateLabel;

        const dateDots = document.createElement('span');
        dateDots.className = 'hstep-date-dots';

        dateSlot.append(dateText, dateDots);
      }
      step.append(dateSlot);

      const dotRow = document.createElement('div');
      dotRow.className = 'hstep-dot-row';
      const dot = document.createElement('span');
      dot.className = 'hstep-dot';
      dotRow.append(dot);
      step.append(dotRow);

      const label = document.createElement('span');
      label.className = 'hstep-label';
      label.textContent = stage.label;
      step.append(label);

      const paymentNote = stagePaymentNote(index, priceAmount, advanceAmount);
      if (paymentNote) {
        const noteText = document.createElement('span');
        noteText.className = 'hstep-payment-note';
        noteText.textContent = paymentNote;
        step.append(noteText);
      }

      stagesEl.appendChild(step);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;

    errorEl.hidden = true;
    resultEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking…';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('track-lookup.php', {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ code }),
      });

      clearTimeout(timeout);
      const json = await response.json();

      if (!response.ok || !json.ok) {
        showError(json.error || 'Something went wrong. Please try again.');
        return;
      }

      labelEl.textContent = json.projectLabel;
      renderStages(
        json.stages,
        json.stage,
        json.createdAt,
        json.deliveryDate,
        json.stageDates,
        Number(json.priceAmount) || 0,
        Number(json.advanceAmount) || 0
      );
      resultEl.hidden = false;
    } catch (err) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Track Project';
    }
  });

  // Auto-fill and auto-submit when arriving from an emailed "Track My
  // Project" link (e.g. track.html?code=7K4M-9XPQ), so the client isn't
  // asked to type a code they were just given.
  const prefillCode = new URLSearchParams(window.location.search).get('code');
  if (prefillCode) {
    codeInput.value = prefillCode.trim();
    form.requestSubmit();
  }
})();
