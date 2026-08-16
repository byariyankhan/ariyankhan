(() => {
  const form = document.getElementById('trackerForm');
  const codeInput = document.getElementById('trackerCode');
  const submitBtn = document.getElementById('trackerSubmit');
  const errorEl = document.getElementById('trackerError');
  const resultEl = document.getElementById('trackerResult');
  const labelEl = document.getElementById('trackerProjectLabel');
  const stagesEl = document.getElementById('trackerStages');
  const noteEl = document.getElementById('trackerNote');
  const noteTextEl = document.getElementById('trackerNoteText');

  if (!form) return;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    resultEl.hidden = true;
  }

  function renderStages(stages, currentStage) {
    stagesEl.innerHTML = '';
    stages.forEach((stage, index) => {
      const state = index < currentStage ? 'done' : index === currentStage ? 'current' : 'upcoming';

      const card = document.createElement('div');
      card.className = `stcard tracker-stcard tracker-stcard--${state}`;

      const num = document.createElement('div');
      num.className = 'stcard-num';
      num.textContent = `Stage 0${index + 1}`;

      const name = document.createElement('h3');
      name.className = 'stcard-name';
      name.textContent = stage.label;

      const desc = document.createElement('p');
      desc.className = 'stcard-desc';
      desc.textContent = stage.desc;

      card.append(num, name, desc);
      stagesEl.appendChild(card);
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
      renderStages(json.stages, json.stage);

      const note = typeof json.note === 'string' ? json.note.trim() : '';
      if (note) {
        noteTextEl.textContent = note;
        noteEl.hidden = false;
      } else {
        noteTextEl.textContent = '';
        noteEl.hidden = true;
      }

      resultEl.hidden = false;
    } catch (err) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Track Project';
    }
  });
})();
