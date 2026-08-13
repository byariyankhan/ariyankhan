/* ══════════════════════════════
   ARIYAN KHAN | Video Editor
   Main JavaScript
══════════════════════════════ */

/* ── Menu ── */

// Cache elements once — the <site-nav> web component has already rendered
// by the time this script runs (scripts are at end of <body>).
const menuBtn     = document.getElementById('menuBtn');
const menuOverlay = document.getElementById('menuOverlay');
// Scope nav lookup to the fixed header so the overlay's inner <nav> is ignored.
const menuNav     = menuBtn?.closest('.site-nav') || document.querySelector('.site-nav');

function syncMenuOverlayOffset() {
  if (!menuNav || !menuOverlay) return;
  // Align overlay top edge to the current header height (accounts for resize).
  menuOverlay.style.setProperty('--menu-offset', `${Math.ceil(menuNav.getBoundingClientRect().height)}px`);
}

function setMenuState(isOpen) {
  if (!menuBtn || !menuOverlay) return;

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

if (menuBtn && menuOverlay) {
  syncMenuOverlayOffset();
  menuBtn.addEventListener('click', () => setMenuState(!menuOverlay.classList.contains('open')));

  // Scope listeners to the overlay — avoids touching unrelated .menu-link elements.
  menuOverlay.querySelectorAll('.menu-link, .menu-cta').forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  // Only recalculate offset on mobile where the overlay is visible.
  window.addEventListener('resize', () => {
    if (window.innerWidth < 1024) syncMenuOverlayOffset();
  });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMenu();
    closeAllDropdowns();
  }
});

/* ── Stars ── */
(function () {
  const starsRoot = document.getElementById('stars');
  if (!starsRoot) return;

  for (let i = 0; i < 90; i++) {
    const star = document.createElement('div');
    const size = Math.random() < 0.25 ? 2.5 : 1.5;

    star.className = 'star';
    star.style.cssText = [
      `left:${Math.random() * 100}%`,
      `top:${Math.random() * 100}%`,
      `width:${size}px`,
      `height:${size}px`,
      `animation-duration:${2 + Math.random() * 5}s`,
      `animation-delay:${Math.random() * 5}s`,
      `background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`,
    ].join(';');

    starsRoot.appendChild(star);
  }
})();

/* ── Counter ── */
let counterStarted = false;
const counterEl = document.getElementById('counterNum');
const TARGET = 5200000;

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

if (counterEl) {
  const counterObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting || counterStarted) return;

    counterStarted = true;

    let current = 0;
    const step = Math.ceil(TARGET / 70);
    const timer = setInterval(() => {
      current = Math.min(current + step, TARGET);
      counterEl.textContent = fmtNum(current);

      if (current >= TARGET) clearInterval(timer);
    }, 28);
  }, { threshold: 0.4 });

  counterObserver.observe(counterEl);
}

/* ── Trust Counter ── */
let trustCounterStarted = false;
const trustCounterEl = document.getElementById('trustCounter');
const TRUST_TARGET = 314;
const TRUST_DURATION = 4000;

function easeOutQuart(x) {
  return 1 - Math.pow(1 - x, 4);
}

if (trustCounterEl) {
  const trustObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting || trustCounterStarted) return;

    trustCounterStarted = true;

    let start = null;
    const step = timestamp => {
      if (!start) start = timestamp;

      const progress = Math.min((timestamp - start) / TRUST_DURATION, 1);
      const current = Math.floor(easeOutQuart(progress) * TRUST_TARGET);

      trustCounterEl.textContent = `${current}+`;
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        trustCounterEl.textContent = `${TRUST_TARGET}+`;
      }
    };

    window.requestAnimationFrame(step);
    trustObserver.disconnect();
  }, { threshold: 0.1 });

  trustObserver.observe(trustCounterEl);
}

/* ── Chart line animation ── */
const redPts = '0,65 30,28 60,55 90,22 120,52 150,20 180,50 210,24 240,58 270,22 300,45';
const greenPts = '0,55 40,42 80,46 120,30 160,34 200,20 240,22 280,16 300,18';

function animateLine(lineId, fillId, pts) {
  const line = document.getElementById(lineId);
  const fill = document.getElementById(fillId);
  if (!line || !fill) return;

  line.setAttribute('points', pts);
  fill.setAttribute('points', `${pts} 300,80 0,80`);

  const length = line.getTotalLength ? line.getTotalLength() : 900;
  line.style.strokeDasharray = length;
  line.style.strokeDashoffset = length;

  requestAnimationFrame(() => {
    line.style.transition = 'stroke-dashoffset 1.8s cubic-bezier(.4,0,.2,1)';
    line.style.strokeDashoffset = '0';
  });
}

const ctrSection = document.querySelector('.ctr-section');
if (ctrSection) {
  const chartObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;

    window.setTimeout(() => {
      animateLine('redLine', 'redFill', redPts);
      animateLine('greenLine', 'greenFill', greenPts);
    }, 200);

    chartObserver.disconnect();
  }, { threshold: 0.3 });

  chartObserver.observe(ctrSection);
}

/* ── Stages wave animation on scroll ── */
const stagesEl = document.getElementById('stages');
const stagesWave = document.getElementById('swp');

if (stagesEl && stagesWave) {
  const stagesWaveObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;

    stagesWave.classList.add('animate');
    stagesWaveObserver.disconnect();
  }, { threshold: 0.3 });

  stagesWaveObserver.observe(stagesEl);
}

/* ── Stats-hero corner cards: fly-in on scroll + hover straighten ── */
const shWrap = document.querySelector('.sh-wrap');

if (shWrap) {
  /* Populate each corner card with a random video from its service category */
  [
    { key: 'talking-head',  corner: 'sh-tl' },
    { key: 'documentary',   corner: 'sh-tr' },
    { key: 'short-form',    corner: 'sh-bl' },
    { key: 'map-animation', corner: 'sh-br' },
  ].forEach(({ key, corner }) => {
    const card = shWrap.querySelector(`.${corner}`);
    const pool = PORTFOLIO.filter(item => item.service === key && item.platform === 'youtube');
    if (!card || !pool.length) return;

    const item = pool[Math.floor(Math.random() * pool.length)];
    const meta = SERVICE_META[key];

    card.href = `${meta.page}#${item.id}`;
    const img = card.querySelector('.fcard-img');
    if (img) img.src = `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`;
  });

  const floatAnimations = {
    'sh-tl': 'sh-floatA 5s ease-in-out infinite',
    'sh-tr': 'sh-floatB 4.5s ease-in-out infinite',
    'sh-bl': 'sh-floatC 5.5s ease-in-out infinite',
    'sh-br': 'sh-floatD 4.8s ease-in-out infinite',
  };

  const cardRotations = {
    'sh-tl': '-9deg',
    'sh-tr': '7deg',
    'sh-bl': '6deg',
    'sh-br': '-8deg',
  };

  function resumeFloatingCard(card, key) {
    // Keep the entered card visible while restarting the idle float loop.
    card.style.opacity = '1';
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = floatAnimations[key];
    card.style.transform = '';
  }

  const shWrapObserver = new IntersectionObserver(entries => {
    const entry = entries[0];

    if (entry.isIntersecting) {
      shWrap.classList.add('sh-visible');
      return;
    }

    shWrap.classList.remove('sh-visible');
    shWrap.querySelectorAll('.sh-tl,.sh-tr,.sh-bl,.sh-br').forEach(card => {
      card.classList.remove('sh-entered');
      card.style.animation = '';
      card.style.transform = '';
      card.style.opacity = '';
    });
  }, { threshold: 0.15 });

  shWrapObserver.observe(shWrap);

  shWrap.querySelectorAll('.sh-tl,.sh-tr,.sh-bl,.sh-br').forEach(card => {
    const key = ['sh-tl', 'sh-tr', 'sh-bl', 'sh-br'].find(cls => card.classList.contains(cls));
    if (!key) return;

    card.addEventListener('animationend', event => {
      if (event.animationName.startsWith('sh-entry')) {
        card.classList.add('sh-entered');
      }
    });

    card.addEventListener('mouseenter', () => {
      if (!card.classList.contains('sh-entered')) return;

      clearTimeout(card._leaveTimer);
      card.style.animation = 'none';
      card.style.opacity = '1';
      card.style.transform = 'rotate(0deg)';
    });

    card.addEventListener('mouseleave', () => {
      if (!card.classList.contains('sh-entered')) return;

      card.style.transform = `rotate(${cardRotations[key]})`;
      card._leaveTimer = setTimeout(() => {
        resumeFloatingCard(card, key);
      }, 460);
    });
  });
}

/* ── Custom Dropdowns ── */
function closeAllDropdowns() {
  document.querySelectorAll('.cdd').forEach(dropdown => {
    dropdown.classList.remove('open');
    dropdown.setAttribute('aria-expanded', 'false');
  });
}

function toggleDd(id) {
  const dropdown = document.getElementById(id);
  if (!dropdown) return;

  const isOpen = dropdown.classList.contains('open');
  closeAllDropdowns();

  if (!isOpen) {
    dropdown.classList.add('open');
    dropdown.setAttribute('aria-expanded', 'true');
  }
}

function selectDd(id, value, icon, meta = {}) {
  const dropdown = document.getElementById(id);
  const valueEl = document.getElementById(`${id}-val`);
  if (!dropdown || !valueEl) return;

  const displayValue = id === 'dd-country'
    ? (value.match(/\(([^)]+)\)/)?.[1] || 'Intl')
    : value;
  valueEl.textContent = `${icon} ${displayValue}`;
  dropdown.classList.add('selected');
  dropdown.classList.remove('open');
  dropdown.setAttribute('aria-expanded', 'false');
  dropdown.dataset.selectedValue = value;
  if (meta.country) dropdown.dataset.selectedCountry = meta.country;
  if (meta.rule) dropdown.dataset.selectedRule = meta.rule;

  dropdown.querySelectorAll('.cdd-opt').forEach(option => {
    option.classList.toggle('active', option.dataset.value === value);
  });

  clearDropdownError(id, `${id}-err`);
  if (id === 'dd-country') updateWhatsappFieldForCountry();
}

function isActivationKey(event) {
  return event.key === 'Enter' || event.key === ' ';
}

function buildCountryDropdown() {
  const menu = document.getElementById('dd-country-menu');
  const dropdown = document.getElementById('dd-country');
  if (!menu || !dropdown) return;

  // Search input — sticky at top of menu
  const searchWrap = document.createElement('div');
  searchWrap.className = 'cdd-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'cdd-search-input';
  searchInput.id = 'dd-country-search';
  searchInput.placeholder = 'Search country\u2026';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Search countries');
  searchWrap.appendChild(searchInput);
  menu.appendChild(searchWrap);

  function makeOpt(country) {
    const label = `${country.name} (${country.dial})`;
    const opt = document.createElement('div');
    opt.className = 'cdd-opt';
    opt.setAttribute('role', 'option');
    opt.dataset.dropdownId = 'dd-country';
    opt.dataset.value = label;
    opt.dataset.country = country.name;
    opt.dataset.icon = country.flag;
    opt.dataset.rule = country.rule;
    opt.setAttribute('tabindex', '0');
    opt.innerHTML = `<span class="cdd-opt-icon" aria-hidden="true">${country.flag}</span><span>${label}</span>`;
    return opt;
  }

  const prioritySet = new Set(PRIORITY_COUNTRY_NAMES);
  const priorityCountries = PRIORITY_COUNTRY_NAMES
    .map(name => COUNTRY_LIST.find(c => c.name === name))
    .filter(Boolean);
  const restCountries = COUNTRY_LIST.filter(c => !prioritySet.has(c.name));

  priorityCountries.forEach(c => menu.appendChild(makeOpt(c)));

  const divider = document.createElement('div');
  divider.className = 'cdd-divider';
  menu.appendChild(divider);

  restCountries.forEach(c => menu.appendChild(makeOpt(c)));

  function filterCountryOptions(q) {
    const lower = q.toLowerCase();
    menu.querySelectorAll('.cdd-opt').forEach(opt => {
      opt.style.display = opt.textContent.toLowerCase().includes(lower) ? '' : 'none';
    });
    divider.style.display = q ? 'none' : '';
  }

  searchInput.addEventListener('input', () => filterCountryOptions(searchInput.value));
  // Prevent search input clicks from bubbling to the document close-all handler
  searchInput.addEventListener('click', e => e.stopPropagation());
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllDropdowns();
    e.stopPropagation();
  });

  // Focus search when dropdown opens; reset when it closes
  new MutationObserver(() => {
    if (dropdown.classList.contains('open')) {
      setTimeout(() => searchInput.focus(), 50);
    } else {
      searchInput.value = '';
      filterCountryOptions('');
    }
  }).observe(dropdown, { attributes: true, attributeFilter: ['class'] });
}

buildCountryDropdown();

document.querySelectorAll('[data-dropdown-trigger]').forEach(trigger => {
  const id = trigger.dataset.dropdownTrigger;
  if (!id) return;

  trigger.addEventListener('click', () => toggleDd(id));
  trigger.addEventListener('keydown', event => {
    if (isActivationKey(event)) {
      event.preventDefault();
      toggleDd(id);
    }
  });
});

document.querySelectorAll('.cdd-opt[data-dropdown-id]').forEach(option => {
  const { dropdownId, value, icon } = option.dataset;
  if (!dropdownId || !value || !icon) return;

  const selectOption = () => selectDd(dropdownId, value, icon, option.dataset);

  option.addEventListener('click', selectOption);
  option.addEventListener('keydown', event => {
    if (!isActivationKey(event)) return;
    event.preventDefault();
    selectOption();
  });
});

document.addEventListener('click', event => {
  if (!event.target.closest('.cdd')) {
    closeAllDropdowns();
  }
});

/* ── Contact form ── */
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const PHONE_RULES = {
  bd: {
    label: 'Bangladesh',
    placeholder: '01712345678',
    help: 'Enter 11 digits starting with 01. Example: 01712345678',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('880')) digits = digits.slice(3);
      if (/^01\d{9}$/.test(digits)) return `+880${digits.slice(1)}`;
      if (/^1\d{9}$/.test(digits)) return `+880${digits}`;
      return null;
    },
  },
  usca: {
    label: 'United States / Canada',
    placeholder: '2015550123',
    help: 'Enter 10 digits. Example: 2015550123',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('1') && digits.length === 11) digits = digits.slice(1);
      return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+1${digits}` : null;
    },
  },
  uk: {
    label: 'United Kingdom',
    placeholder: '07123456789',
    help: 'Enter a UK mobile number. Example: 07123456789',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('44')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^7\d{9}$/.test(digits) ? `+44${digits}` : null;
    },
  },
  in: {
    label: 'India',
    placeholder: '09876543210',
    help: 'Enter 10 digits starting with 6-9. Example: 09876543210',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('91')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
    },
  },
  pk: {
    label: 'Pakistan',
    placeholder: '03123456789',
    help: 'Enter a mobile number. Example: 03123456789',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('92')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^3\d{9}$/.test(digits) ? `+92${digits}` : null;
    },
  },
  ae: {
    label: 'United Arab Emirates',
    placeholder: '0501234567',
    help: 'Enter a UAE mobile number. Example: 0501234567',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('971')) digits = digits.slice(3);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^5\d{8}$/.test(digits) ? `+971${digits}` : null;
    },
  },
  sa: {
    label: 'Saudi Arabia',
    placeholder: '0512345678',
    help: 'Enter a Saudi mobile number. Example: 0512345678',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('966')) digits = digits.slice(3);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^5\d{8}$/.test(digits) ? `+966${digits}` : null;
    },
  },
  au: {
    label: 'Australia',
    placeholder: '0412345678',
    help: 'Enter an Australian mobile number. Example: 0412345678',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('61')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^4\d{8}$/.test(digits) ? `+61${digits}` : null;
    },
  },
  nz: {
    label: 'New Zealand',
    placeholder: '0211234567',
    help: 'Enter NZ mobile number starting with 02. Example: 0211234567',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('64')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^2\d{7,9}$/.test(digits) ? `+64${digits}` : null;
    },
  },
  de: {
    label: 'Germany',
    placeholder: '015112345678',
    help: 'Enter German mobile number starting with 015/016/017. Example: 015112345678',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('49')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^1[5-7]\d{8,10}$/.test(digits) ? `+49${digits}` : null;
    },
  },
  nl: {
    label: 'Netherlands',
    placeholder: '0612345678',
    help: 'Enter Dutch mobile number starting with 06. Example: 0612345678',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('31')) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.slice(1);
      return /^6\d{8}$/.test(digits) ? `+31${digits}` : null;
    },
  },
  sg: {
    label: 'Singapore',
    placeholder: '91234567',
    help: 'Enter Singapore mobile number starting with 8 or 9. Example: 91234567',
    normalize(value) {
      let digits = stripPhoneDigits(value);
      if (digits.startsWith('65')) digits = digits.slice(2);
      return /^[89]\d{7}$/.test(digits) ? `+65${digits}` : null;
    },
  },
  other: {
    label: 'Other International',
    placeholder: '+4915123456789',
    help: 'Enter your full number including the country code.',
    normalize(value) {
      if (!/^\+?[0-9().\s-]+$/.test(value.trim())) return null;
      const digits = stripPhoneDigits(value);
      return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
    },
  },
};

function stripPhoneDigits(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

function getSelectedCountryRule() {
  const dropdown = document.getElementById('dd-country');
  const ruleKey = dropdown?.dataset.selectedRule || '';
  if (!ruleKey || !PHONE_RULES[ruleKey]) return null;

  return {
    key: ruleKey,
    label: dropdown.dataset.selectedCountry || PHONE_RULES[ruleKey].label,
    ...PHONE_RULES[ruleKey],
  };
}

function normalizeWhatsappByCountry(value, ruleKey) {
  const rule = PHONE_RULES[ruleKey];
  if (!rule) return null;

  return rule.normalize(value.trim());
}

function isValidWhatsapp(value, ruleKey) {
  return Boolean(normalizeWhatsappByCountry(value, ruleKey));
}

function setDropdownError(id, errorId, message) {
  const dropdown = document.getElementById(id);
  const error = document.getElementById(errorId);
  if (dropdown) dropdown.classList.add('error');

  if (error) {
    if (message) error.textContent = message;
    error.classList.add('is-visible');
  }
}

function clearDropdownError(id, errorId) {
  const dropdown = document.getElementById(id);
  const error = document.getElementById(errorId);
  if (dropdown) dropdown.classList.remove('error');
  if (error) error.classList.remove('is-visible');
}

function updateWhatsappFieldForCountry() {
  const field = document.getElementById('cf-whatsapp');
  const help = document.getElementById('cf-whatsapp-help');
  const selectedCountry = getSelectedCountryRule();
  if (!field || !help) return;

  if (!selectedCountry) {
    field.placeholder = '+1 234 567 8900';
    help.textContent = '';
    return;
  }

  field.placeholder = selectedCountry.placeholder;
  help.textContent = selectedCountry.help;
}

function setFieldError(fieldId, errorId, message) {
  const field = document.getElementById(fieldId);
  const error = document.getElementById(errorId);
  if (!field) return;

  field.classList.add('error');
  field.setAttribute('aria-invalid', 'true');

  if (error) {
    if (message) error.textContent = message;
    error.classList.add('is-visible');
  }
}

function clearFieldError(fieldId, errorId) {
  const field = document.getElementById(fieldId);
  const error = document.getElementById(errorId);
  if (!field) return;

  field.classList.remove('error');
  field.removeAttribute('aria-invalid');
  if (error) error.classList.remove('is-visible');
}

function getDropdownValue(id) {
  const dropdown = document.getElementById(id);
  if (!dropdown || !dropdown.classList.contains('selected')) return 'Not selected';
  return dropdown.dataset.selectedValue || 'Not selected';
}

function resetDropdown(id, placeholder) {
  const dropdown = document.getElementById(id);
  const valueEl = document.getElementById(`${id}-val`);
  if (!dropdown || !valueEl) return;

  dropdown.classList.remove('selected', 'open');
  dropdown.setAttribute('aria-expanded', 'false');
  delete dropdown.dataset.selectedValue;
  delete dropdown.dataset.selectedCountry;
  delete dropdown.dataset.selectedRule;
  valueEl.textContent = placeholder;

  dropdown.querySelectorAll('.cdd-opt').forEach(option => option.classList.remove('active'));

  clearDropdownError(id, `${id}-err`);
  if (id === 'dd-country') updateWhatsappFieldForCountry();
}

function resetSubmitButton(btn) {
  btn.innerHTML = '<span class="cta-arr">»</span> Send Message';
  btn.classList.remove('is-loading', 'is-success', 'is-error');
  btn.disabled = false;
}

function setSubmitState(btn, state, label) {
  btn.classList.remove('is-loading', 'is-success', 'is-error');
  if (state) btn.classList.add(state);
  btn.textContent = label;
}

async function handleSubmit(btn) {
  const name          = document.getElementById('cf-name')?.value.trim()     || '';
  const email         = document.getElementById('cf-email')?.value.trim()    || '';
  const whatsapp      = document.getElementById('cf-whatsapp')?.value.trim() || '';
  const message       = document.getElementById('cf-message')?.value.trim()  || '';
  const service       = getDropdownValue('dd1');
  const budget        = getDropdownValue('dd2');
  const selectedCountry = getSelectedCountryRule();

  // Clear all errors before re-validating
  clearFieldError('cf-name',     'cf-name-err');
  clearFieldError('cf-email',    'cf-email-err');
  clearDropdownError('dd-country', 'dd-country-err');
  clearFieldError('cf-whatsapp', 'cf-whatsapp-err');
  clearDropdownError('dd1',      'dd1-err');
  clearDropdownError('dd2',      'dd2-err');
  clearFieldError('cf-message',  'cf-message-err');

  // Validate all fields at once; track elements to focus the first invalid one
  const invalidEls = [];

  if (!name) {
    setFieldError('cf-name', 'cf-name-err', 'Your name is required.');
    invalidEls.push(document.getElementById('cf-name'));
  }

  if (!email) {
    setFieldError('cf-email', 'cf-email-err', 'Email is required.');
    invalidEls.push(document.getElementById('cf-email'));
  } else if (!isValidEmail(email)) {
    setFieldError('cf-email', 'cf-email-err', 'Please enter a valid email address.');
    invalidEls.push(document.getElementById('cf-email'));
  }

  if (!selectedCountry) {
    setDropdownError('dd-country', 'dd-country-err', 'Please select your country first.');
    invalidEls.push(document.querySelector('[data-dropdown-trigger="dd-country"]'));
  }

  if (!whatsapp) {
    setFieldError('cf-whatsapp', 'cf-whatsapp-err', 'WhatsApp number is required.');
    invalidEls.push(document.getElementById('cf-whatsapp'));
  } else if (selectedCountry && !isValidWhatsapp(whatsapp, selectedCountry.key)) {
    setFieldError('cf-whatsapp', 'cf-whatsapp-err', `Enter a valid ${selectedCountry.label} number.`);
    invalidEls.push(document.getElementById('cf-whatsapp'));
  }

  if (!document.getElementById('dd1')?.classList.contains('selected')) {
    setDropdownError('dd1', 'dd1-err', 'Please select a project type.');
    invalidEls.push(document.querySelector('[data-dropdown-trigger="dd1"]'));
  }

  if (!document.getElementById('dd2')?.classList.contains('selected')) {
    setDropdownError('dd2', 'dd2-err', 'Please select a budget range.');
    invalidEls.push(document.querySelector('[data-dropdown-trigger="dd2"]'));
  }

  if (!message) {
    setFieldError('cf-message', 'cf-message-err', 'Please describe your project.');
    invalidEls.push(document.getElementById('cf-message'));
  }

  if (invalidEls.length) {
    invalidEls[0]?.focus();
    setSubmitState(btn, 'is-error', 'Fill all fields');
    setTimeout(() => resetSubmitButton(btn), 2500);
    return;
  }

  setSubmitState(btn, 'is-loading', 'Sending...');
  btn.disabled = true;

  try {
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch('send-mail.php', {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        name,
        email,
        whatsapp,
        whatsappCountry: selectedCountry.label,
        whatsappRule: selectedCountry.key,
        message,
        service,
        budget,
      }),
    });

    clearTimeout(fetchTimeout);
    const json = await response.json();
    if (!response.ok || !json.ok) {
      if (json.error === 'Invalid email address') {
        setFieldError('cf-email', 'cf-email-err', 'Please enter a valid email address.');
        document.getElementById('cf-email')?.focus();
      }

      if (json.error === 'Invalid WhatsApp number') {
        setFieldError('cf-whatsapp', 'cf-whatsapp-err', 'Please enter a valid WhatsApp number for the selected country.');
        document.getElementById('cf-whatsapp')?.focus();
      }

      throw new Error(json.error || 'failed');
    }

    setSubmitState(btn, 'is-success', 'Message Sent!');
    if (typeof fbq === 'function') {
      fbq('track', 'Lead');
    }

    ['cf-name', 'cf-email', 'cf-whatsapp', 'cf-message'].forEach(id => {
      const field = document.getElementById(id);
      if (field) field.value = '';
    });

    resetDropdown('dd-country', 'Country');
    resetDropdown('dd1', 'Select a service...');
    resetDropdown('dd2', 'Select budget...');

    setTimeout(() => resetSubmitButton(btn), 3500);
  } catch (error) {
    setSubmitState(btn, 'is-error', 'Error, try again');
    btn.disabled = false;
    console.error('Form error:', error.message);

    setTimeout(() => resetSubmitButton(btn), 3000);
  }
}

const contactSubmit = document.getElementById('contactSubmit');
if (contactSubmit) {
  contactSubmit.addEventListener('click', () => handleSubmit(contactSubmit));
}

const nameField = document.getElementById('cf-name');
if (nameField) {
  nameField.addEventListener('input', () => {
    if (nameField.value.trim()) clearFieldError('cf-name', 'cf-name-err');
  });
}

const emailField = document.getElementById('cf-email');
if (emailField) {
  emailField.addEventListener('input', () => {
    if (!emailField.value.trim() || isValidEmail(emailField.value.trim())) {
      clearFieldError('cf-email', 'cf-email-err');
    }
  });
}

const whatsappField = document.getElementById('cf-whatsapp');
if (whatsappField) {
  whatsappField.addEventListener('input', () => {
    const selectedCountry = getSelectedCountryRule();
    if (
      !whatsappField.value.trim() ||
      (selectedCountry && isValidWhatsapp(whatsappField.value.trim(), selectedCountry.key))
    ) {
      clearFieldError('cf-whatsapp', 'cf-whatsapp-err');
    }
  });
}

const messageField = document.getElementById('cf-message');
if (messageField) {
  messageField.addEventListener('input', () => {
    if (messageField.value.trim()) clearFieldError('cf-message', 'cf-message-err');
  });
}

updateWhatsappFieldForCountry();

/* ── FAQ accordion ── */
function runTypewriter(p, text) {
  if (p._twTimer) { clearTimeout(p._twTimer); p._twTimer = null; }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    p.textContent = text;
    return;
  }
  p.textContent = '';
  const n = text.length;
  function type(i) {
    p.textContent = text.slice(0, i);
    if (i >= n) { p._twTimer = null; return; }
    const t = n > 1 ? i / (n - 1) : 1;
    p._twTimer = setTimeout(() => type(i + 1), 6 + 22 * t * t);
  }
  type(1);
}

function setFaqState(item, isOpen) {
  if (!item) return;

  const button = item.querySelector('.faq-q');
  const answer = item.querySelector('.faq-a');
  const p = answer?.querySelector('p');
  if (!button || !answer) return;

  if (p && !p.dataset.fullText) p.dataset.fullText = p.textContent;

  item.classList.toggle('open', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
  answer.setAttribute('aria-hidden', String(!isOpen));

  if (!p) return;
  if (isOpen) {
    runTypewriter(p, p.dataset.fullText);
  } else {
    if (p._twTimer) { clearTimeout(p._twTimer); p._twTimer = null; }
    p.textContent = p.dataset.fullText ?? p.textContent;
  }
}

function toggleFaq(item) {
  const wasOpen = item?.classList.contains('open');
  document.querySelectorAll('.faq-item').forEach(faqItem => setFaqState(faqItem, false));
  if (!wasOpen) setFaqState(item, true);
}

document.querySelectorAll('.faq-q').forEach(button => {
  button.addEventListener('click', () => toggleFaq(button.closest('.faq-item')));
});

/* Service card accordions */
function setServiceCardState(card, isOpen) {
  if (!card) return;

  const button = card.querySelector('.what-i-do-card-toggle');
  const panel = card.querySelector('.what-i-do-card-panel');
  const p = panel?.querySelector('p');
  if (!button || !panel) return;

  if (p && !p.dataset.fullText) p.dataset.fullText = p.textContent;

  card.classList.toggle('open', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
  panel.setAttribute('aria-hidden', String(!isOpen));

  if (!p) return;
  if (isOpen) {
    runTypewriter(p, p.dataset.fullText);
  } else {
    if (p._twTimer) { clearTimeout(p._twTimer); p._twTimer = null; }
    p.textContent = p.dataset.fullText ?? p.textContent;
  }
}

document.querySelectorAll('[data-service-card-accordion] .what-i-do-card--accordion').forEach(card => {
  const button = card.querySelector('.what-i-do-card-toggle');
  if (!button) return;

  setServiceCardState(card, card.classList.contains('open'));
  button.addEventListener('click', () => {
    const wasOpen = card.classList.contains('open');
    const group = card.closest('[data-service-card-accordion]');

    group
      ?.querySelectorAll('.what-i-do-card--accordion')
      .forEach(accordionCard => setServiceCardState(accordionCard, false));

    if (!wasOpen) setServiceCardState(card, true);
  });
});

/* Process step accordions */
function setProcessStepState(card, isOpen) {
  if (!card) return;

  const button = card.querySelector('.process-step-toggle');
  const panel = card.querySelector('.process-step-panel');
  const p = panel?.querySelector('p');
  if (!button || !panel) return;

  if (p && !p.dataset.fullText) p.dataset.fullText = p.textContent;

  card.classList.toggle('open', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
  panel.setAttribute('aria-hidden', String(!isOpen));

  if (!p) return;
  if (isOpen) {
    runTypewriter(p, p.dataset.fullText);
  } else {
    if (p._twTimer) { clearTimeout(p._twTimer); p._twTimer = null; }
    p.textContent = p.dataset.fullText ?? p.textContent;
  }
}

document.querySelectorAll('[data-process-step-accordion] .process-step-card--accordion').forEach(card => {
  const button = card.querySelector('.process-step-toggle');
  if (!button) return;

  setProcessStepState(card, card.classList.contains('open'));
  button.addEventListener('click', () => {
    const wasOpen = card.classList.contains('open');
    const group = card.closest('[data-process-step-accordion]');

    group
      ?.querySelectorAll('.process-step-card--accordion')
      .forEach(accordionCard => setProcessStepState(accordionCard, false));

    if (!wasOpen) setProcessStepState(card, true);
  });
});

/* ══════════════════════════════════════════════════
   PORTFOLIO — Video Player & Grid Builder
══════════════════════════════════════════════════ */

/* ── YouTube title cache (oEmbed, no API key needed) ── */
const ytCache = {};

async function fetchYTTitle(id) {
  if (ytCache[id]) return ytCache[id];

  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
    );

    if (!response.ok) return null;

    const data = await response.json();
    ytCache[id] = data.title;
    return data.title;
  } catch {
    return null;
  }
}

/* ── Stop all playing videos (restore thumbnails) ── */
function stopAllVideos() {
  document.querySelectorAll('.pf-card.pf-playing').forEach(card => {
    const thumb = card.querySelector('.pf-thumb');
    if (thumb && card._origHTML !== undefined) {
      thumb.innerHTML = card._origHTML;
    }

    card.classList.remove('pf-playing');
  });
}

/* ── Embed video inside card thumbnail area ── */
function embedVideo(card, src, allow) {
  const thumb = card.querySelector('.pf-thumb');
  if (!thumb) return;

  card._origHTML = thumb.innerHTML;
  thumb.innerHTML = `<iframe class="pf-frame" src="${src}"
    allow="${allow || 'autoplay'}"
    allowfullscreen
    ></iframe>`;
  card.classList.add('pf-playing');
}

/* ── Build service page grid ── */
const PF_PAGE_SIZE = 8;

function buildPortfolioGrid(service) {
  if (typeof PORTFOLIO === 'undefined' || PORTFOLIO.length === 0) return;

  const grid = document.getElementById('pf-grid');
  if (!grid) return;

  const pool = service === 'random-core'
    ? [...PORTFOLIO.filter(i => i.service !== 'wedding-video-editing' && i.service !== 'short-form')].sort(() => Math.random() - 0.5)
    : service === 'random-no-short'
    ? [...PORTFOLIO.filter(i => i.service !== 'short-form')].sort(() => Math.random() - 0.5)
    : PORTFOLIO.filter(item => item.service === service);
  if (pool.length === 0) return;

  grid.innerHTML = '';
  document.getElementById('featured-work-load-more')?.remove();

  let shown = 0;

  function renderBatch() {
    const batch = pool.slice(shown, shown + PF_PAGE_SIZE);
    batch.forEach(item => grid.appendChild(makePfCard(item)));
    shown += batch.length;

    const btn = document.getElementById('featured-work-load-more');
    if (btn) btn.hidden = shown >= pool.length;
  }

  if (pool.length > PF_PAGE_SIZE) {
    const btn = document.createElement('button');
    btn.id        = 'featured-work-load-more';
    btn.className = 'featured-work-load-more';
    btn.textContent = 'Load More';
    grid.insertAdjacentElement('afterend', btn);
    btn.addEventListener('click', renderBatch);
  }

  // Render enough batches to include the hash-targeted video (may be beyond page 1)
  const hashId    = window.location.hash.slice(1);
  const hashIndex = hashId ? pool.findIndex(item => item.id === hashId) : -1;

  do {
    renderBatch();
  } while (hashIndex >= shown && shown < pool.length);

  scrollToHashVideo();
}

/* -- Hero card portfolio slider -- */
function initHeroPortfolioSlider() {
  if (typeof PORTFOLIO === 'undefined' || PORTFOLIO.length === 0) return;

  document.querySelectorAll('[data-hero-portfolio-slider]').forEach(slider => {
    const service = slider.dataset.heroPortfolioSlider;
    const portfolioItems = PORTFOLIO.filter(item => item.service === service && item.platform === 'youtube');
    if (portfolioItems.length < 2) return;

    const trigger = slider.querySelector('.service-profile-media-link');
    const currentImg = slider.querySelector('[data-hero-slide-current]');
    const nextImg = slider.querySelector('[data-hero-slide-next]');
    const prevBtn = slider.querySelector('[data-hero-slide-prev]');
    const nextBtn = slider.querySelector('[data-hero-slide-next-btn]');
    if (!trigger || !currentImg || !nextImg) return;

    // If page sets data-hero-initial-src, prepend it as a virtual static slide (no video).
    const initialSrc = slider.dataset.heroInitialSrc;
    const items = initialSrc
      ? [{ id: null, staticSrc: initialSrc, alt: currentImg.alt }, ...portfolioItems]
      : portfolioItems;

    let index = 0;
    let timer = null;
    let isAnimating = false;

    function thumbUrl(id) {
      return `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
    }

    function fallbackThumbUrl(id) {
      return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
    }

    function setImage(img, item, hideFromAT) {
      if (item.staticSrc) {
        img.src = item.staticSrc;
        img.alt = hideFromAT ? '' : (item.alt || '');
        img.onerror = null;
      } else {
        img.src = thumbUrl(item.id);
        img.onerror = () => {
          img.onerror = null;
          img.src = fallbackThumbUrl(item.id);
        };
        img.alt = hideFromAT ? '' : getPortfolioAltText(item, item.title || '');
      }
      img.setAttribute('aria-hidden', String(hideFromAT));
    }

    function syncState(item) {
      const isStatic = !item.id;
      slider.classList.toggle('is-static', isStatic);
      trigger.dataset.videoId = item.id || '';
    }

    setImage(currentImg, items[0], false);
    syncState(items[0]);
    currentImg.style.opacity = '1';
    currentImg.style.transform = 'translateX(0)';
    nextImg.style.opacity = '0';

    function queueNextSlide() {
      timer = window.setInterval(() => showSlide(1), 3800);
    }

    function resetAutoSlide() {
      if (timer) window.clearInterval(timer);
      if (slider.classList.contains('is-playing')) return;
      queueNextSlide();
    }

    function showSlide(direction = 1) {
      if (isAnimating) return;
      isAnimating = true;
      const nextIndex = (index + direction + items.length) % items.length;
      const nextItem = items[nextIndex];
      const isPlaying = slider.classList.contains('is-playing');
      const incomingStart = direction > 0 ? '-100%' : '100%';
      const outgoingEnd = direction > 0 ? '100%' : '-100%';

      if (isPlaying) {
        stopVideo();
      }

      setImage(nextImg, nextItem, false);
      currentImg.className = 'service-profile-image is-active';
      nextImg.className = 'service-profile-image';

      currentImg.style.transition = 'none';
      nextImg.style.transition = 'none';
      currentImg.style.opacity = '1';
      currentImg.style.transform = 'translateX(0)';
      nextImg.style.opacity = '1';
      nextImg.style.transform = `translateX(${incomingStart})`;
      nextImg.offsetHeight;

      currentImg.style.transition = '';
      nextImg.style.transition = '';
      currentImg.style.opacity = '0';
      currentImg.style.transform = `translateX(${outgoingEnd})`;
      nextImg.style.opacity = '1';
      nextImg.style.transform = 'translateX(0)';

      window.setTimeout(() => {
        currentImg.className = 'service-profile-image is-active';
        nextImg.className = 'service-profile-image';
        setImage(currentImg, nextItem, false);
        setImage(nextImg, items[(nextIndex + direction + items.length) % items.length], true);
        currentImg.style.transition = 'none';
        nextImg.style.transition = 'none';
        currentImg.style.opacity = '1';
        currentImg.style.transform = 'translateX(0)';
        nextImg.style.opacity = '0';
        nextImg.style.transform = `translateX(${incomingStart})`;
        nextImg.offsetHeight;
        currentImg.style.transition = '';
        nextImg.style.transition = '';
        syncState(nextItem);
        index = nextIndex;
        isAnimating = false;
      }, 580);
    }

    queueNextSlide();

    prevBtn?.addEventListener('click', event => {
      event.stopPropagation();
      showSlide(-1);
      resetAutoSlide();
    });

    nextBtn?.addEventListener('click', event => {
      event.stopPropagation();
      showSlide(1);
      resetAutoSlide();
    });

    function stopVideo() {
      slider.querySelector('.service-profile-frame')?.remove();
      slider.classList.remove('is-playing');
    }

    function playVideo(videoId) {
      const existingFrame = slider.querySelector('.service-profile-frame');
      const src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;
      if (existingFrame) {
        existingFrame.src = src;
        return;
      }

      if (timer) window.clearInterval(timer);
      slider.classList.add('is-playing');
      slider.insertAdjacentHTML('beforeend', `<iframe class="service-profile-frame" src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1"
        title="Portfolio video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen></iframe>`);
    }

    trigger.addEventListener('click', () => {
      const videoId = trigger.dataset.videoId;
      if (!videoId) return;
      playVideo(videoId);
    });
  });
}

/* ── Deep-link scroll: navigate from homepage thumbnail to exact video on category page ── */
function scrollToHashVideo() {
  const id = window.location.hash.slice(1); // strip leading '#'
  if (!id) return;

  const card = document.getElementById(id);
  if (!card) return;

  // rAF lets the grid finish painting before scroll position is calculated
  requestAnimationFrame(() => {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('pf-card--highlighted');
    setTimeout(() => card.classList.remove('pf-card--highlighted'), 2000);
  });
}

function getPortfolioAltText(item, title = '') {
  const meta = SERVICE_META[item.service] || { label: 'Video' };

  if (title) {
    return `${title} - ${meta.label} video edited by Ariyan Khan`;
  }

  if (item.vertical) {
    return `${meta.label} short-form video thumbnail edited by Ariyan Khan`;
  }

  return `${meta.label} video thumbnail edited by Ariyan Khan`;
}

function makePfCard(item) {
  const isYoutube = item.platform === 'youtube';
  const isDrive = item.platform === 'drive';
  const isFacebook = item.platform === 'facebook';
  const thumbClass = item.vertical ? ' pf-thumb-v' : '';
  const defaultAltText = getPortfolioAltText(item, item.title || '');
  const thumbWidth = item.vertical ? 270 : 480;
  const thumbHeight = item.vertical ? 480 : 270;

  const card = document.createElement('div');
  card.className = 'pf-card';
  card.id = item.id; // YouTube ID used as HTML id for deep-link scroll from homepage

  if (isYoutube) {
    const highQualityThumb = `https://img.youtube.com/vi/${item.id}/maxresdefault.jpg`;
    const fallbackThumb = `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`;

    card.innerHTML = `
      <div class="pf-thumb${thumbClass}">
        <img src="${highQualityThumb}" alt="${defaultAltText}" loading="lazy" decoding="async" width="${thumbWidth}" height="${thumbHeight}" onerror="this.src='${fallbackThumb}'">
        <div class="pf-play">▶</div>
      </div>
      <div class="pf-info pf-info-hidden">
        <div class="pf-name">${item.title || ''}</div>
      </div>`;

    card.addEventListener('click', () => {
      if (card.classList.contains('pf-playing')) {
        stopAllVideos();
        return;
      }

      stopAllVideos();
      embedVideo(
        card,
        `https://www.youtube.com/embed/${item.id}?autoplay=1&rel=0&modestbranding=1`,
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
      );
    });

    const nameEl = card.querySelector('.pf-name');
    const infoEl = card.querySelector('.pf-info');
    const thumbImg = card.querySelector('img');
    if (item.title && infoEl) infoEl.classList.remove('pf-info-hidden');

    fetchYTTitle(item.id).then(title => {
      if (!title || !nameEl || !infoEl) return;
      nameEl.textContent = title;
      infoEl.classList.remove('pf-info-hidden');
      if (thumbImg) thumbImg.alt = getPortfolioAltText(item, title);
    });
  } else if (isDrive) {
    card.innerHTML = `
      <div class="pf-thumb${thumbClass}">
        <div class="pf-click-ph">
          <span class="pf-click-ph-icon">📁</span>
          <span class="pf-click-ph-txt">Click to Play</span>
        </div>
      </div>
      <div class="pf-info">
        <div class="pf-name">${item.title || 'Drive Video'}</div>
      </div>`;

    card.addEventListener('click', () => {
      if (card.classList.contains('pf-playing')) {
        stopAllVideos();
        return;
      }

      stopAllVideos();
      embedVideo(card, `https://drive.google.com/file/d/${item.id}/preview`, 'autoplay');
    });
  } else if (isFacebook) {
    const encodedUrl = encodeURIComponent(item.url || '');

    card.innerHTML = `
      <div class="pf-thumb${thumbClass}">
        <div class="pf-click-ph">
          <span class="pf-click-ph-icon">▶</span>
          <span class="pf-click-ph-txt">Click to Play</span>
        </div>
      </div>
      <div class="pf-info">
        <div class="pf-name">${item.title || 'Facebook Video'}</div>
      </div>`;

    card.addEventListener('click', () => {
      if (card.classList.contains('pf-playing')) {
        stopAllVideos();
        return;
      }

      stopAllVideos();
      embedVideo(
        card,
        `https://www.facebook.com/plugins/video.php?href=${encodedUrl}&show_text=0&autoplay=1`,
        'autoplay; clipboard-write; encrypted-media; picture-in-picture'
      );
    });
  }

  return card;
}

/* ── Home page marquee: rebuild from portfolio data ── */
(function () {
  if (typeof PORTFOLIO === 'undefined' || PORTFOLIO.length === 0) return;

  const track = document.getElementById('marqueeTrack');
  if (!track) return;

  function interleaveByCategory(items) {
    // Group items by service category
    const groups = {};
    items.forEach(item => {
      if (!groups[item.service]) groups[item.service] = [];
      groups[item.service].push(item);
    });

    // Shuffle each category independently (Fisher-Yates)
    Object.values(groups).forEach(group => {
      for (let i = group.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [group[i], group[j]] = [group[j], group[i]];
      }
    });

    // Round-robin: pull one from each category in turn to avoid clustering
    const services = Object.keys(groups);
    const maxLen = Math.max(...services.map(service => groups[service].length));
    const result = [];
    for (let i = 0; i < maxLen; i++) {
      services.forEach(service => {
        if (groups[service][i]) result.push(groups[service][i]);
      });
    }
    return result;
  }

  const longForm = PORTFOLIO.filter(item => item.service !== 'short-form');
  const interleaved = interleaveByCategory(longForm);
  // Doubled so the CSS marquee animation loops seamlessly (scrolls exactly 50% then resets)
  const doubled = [...interleaved, ...interleaved];

  track.innerHTML = doubled.map(item => {
    const meta = SERVICE_META[item.service];
    const isYoutube = item.platform === 'youtube';
    const thumb = isYoutube
      ? `<img class="work-thumb-media" src="https://img.youtube.com/vi/${item.id}/mqdefault.jpg" alt="${getPortfolioAltText(item)}" loading="lazy" decoding="async" width="320" height="180">`
      : `<span class="work-thumb-icon" aria-hidden="true">${meta.icon}</span>`;
    const verticalClass = item.vertical ? ' work-thumb-v' : '';
    const serviceClass = ` work-thumb--${item.service}`;

    return `<a href="${meta.page}#${item.id}" class="work-thumb${serviceClass}${verticalClass}">
      <div class="work-thumb-inner">
        ${thumb}
        <div class="work-thumb-overlay"></div>
        <div class="work-thumb-label">${meta.label}</div>
      </div>
    </a>`;
  }).join('');

  track.setAttribute('aria-busy', 'false');
})();

/* ── Service pre-selection via URL param ──────────────────────────────────
   Usage: link to /?service=<key>#contact from any service page.
   To add a new service: append an entry to SERVICE_PARAM_MAP below.
   Keys must match the `service` query param value in the CTA href.
   Values must match the exact `data-value` and `data-icon` on the cdd-opt.
──────────────────────────────────────────────────────────────────────── */
const SERVICE_PARAM_MAP = {
  'talking-head':  { value: 'Talking Head Video Editing',              icon: '🎙️' },
  'documentary':   { value: 'Documentary Video Editing',               icon: '🎬' },
  'short-form':    { value: 'Short Form (TikTok / Reels / Shorts)',    icon: '📱' },
  'map-animation': { value: 'Map Animation & Geopolitical Visuals',    icon: '🗺️' },
  'wedding-video-editing': { value: 'Wedding Video Editing Services',  icon: '💍' },
};

(function applyServiceParam() {
  const key = new URLSearchParams(window.location.search).get('service');
  if (!key) return;

  const entry = SERVICE_PARAM_MAP[key];
  if (!entry) return;

  selectDd('dd1', entry.value, entry.icon);
})();

/* ── Scroll to top ── */
(function () {
  const btn = document.createElement('button');
  btn.className = 'scroll-top';
  btn.setAttribute('aria-label', 'Scroll to top');
  btn.innerHTML = '&#8679;';
  document.body.appendChild(btn);

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      btn.classList.toggle('visible', window.scrollY > 400);
      ticking = false;
    });
  }, { passive: true });

  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();
