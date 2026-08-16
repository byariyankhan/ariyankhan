(() => {
  const form = document.getElementById('trackerForm');
  const codeInput = document.getElementById('trackerCode');
  const submitBtn = document.getElementById('trackerSubmit');
  const errorEl = document.getElementById('trackerError');
  const resultEl = document.getElementById('trackerResult');
  const labelEl = document.getElementById('trackerProjectLabel');
  const metaEl = document.getElementById('trackerMeta');
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

  function renderMeta(createdAt, deliveryDate) {
    const parts = [];
    const created = formatDate(createdAt);
    if (created) parts.push(`Started ${created}`);
    const delivery = formatDate(deliveryDate);
    if (delivery) parts.push(`Expected delivery ${delivery}`);
    metaEl.textContent = parts.join(' · ');
    metaEl.hidden = parts.length === 0;
  }

  function renderStages(stages, currentStage, note) {
    stagesEl.innerHTML = '';
    stages.forEach((stage, index) => {
      const state = index < currentStage ? 'done' : index === currentStage ? 'current' : 'upcoming';

      const step = document.createElement('div');
      step.className = `hstep hstep--${state}`;

      const dot = document.createElement('span');
      dot.className = 'hstep-dot';

      const label = document.createElement('span');
      label.className = 'hstep-label';
      label.textContent = stage.label;

      step.append(dot, label);

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
      renderMeta(json.createdAt, json.deliveryDate);
      renderStages(json.stages, json.stage, note);
      resultEl.hidden = false;
    } catch (err) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Track Project';
    }
  });
})();
