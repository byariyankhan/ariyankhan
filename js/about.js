(function () {
  function initSkillBars() {
    var bars = document.querySelectorAll('.about-skill-bar');
    if (!bars.length || !window.IntersectionObserver) return;

    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var bar = entry.target;
        var fill = bar.querySelector('.about-skill-fill');
        if (fill) fill.style.width = (bar.dataset.level || 0) + '%';
        obs.unobserve(bar);
      });
    }, { threshold: 0.4 });

    bars.forEach(function (b) { obs.observe(b); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSkillBars);
  } else {
    initSkillBars();
  }
})();
