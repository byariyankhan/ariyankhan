(() => {
  const form = document.getElementById('trackerForm');
  const codeInput = document.getElementById('trackerCode');
  const submitBtn = document.getElementById('trackerSubmit');
  const errorEl = document.getElementById('trackerError');
  const resultEl = document.getElementById('trackerResult');
  const labelEl = document.getElementById('trackerProjectLabel');
  const stagesEl = document.getElementById('trackerStages');

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

  function renderStages(stages, currentStage, note, createdAt, deliveryDate) {
    stagesEl.innerHTML = '';
    const lastIndex = stages.length - 1;
    const createdLabel = formatDate(createdAt);
    const deliveryLabel = formatDate(deliveryDate);

    stages.forEach((stage, index) => {
      const state = index < currentStage ? 'done' : index === currentStage ? 'current' : 'upcoming';

      const step = document.createElement('div');
      step.className = `hstep hstep--${state}`;

      const dateSlot = document.createElement('div');
      dateSlot.className = 'hstep-date-slot';
      const dateLabel = index === 0 ? createdLabel : index === lastIndex ? deliveryLabel : '';
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

      if (state === 'current' && note) {
        const noteEl = document.createElement('span');
        noteEl.className = 'hstep-note';
        noteEl.textContent = note;
        step.append(noteEl);
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

      const note = typeof json.note === 'string' ? json.note.trim() : '';
      labelEl.textContent = json.projectLabel;
      renderStages(json.stages, json.stage, note, json.createdAt, json.deliveryDate);
      resultEl.hidden = false;
    } catch (err) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Track Project';
    }
  });
})();
