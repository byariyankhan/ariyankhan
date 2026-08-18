// Shared service-page profile data + renderer.
const SITE = {
  name:         'Ariyan Khan',
  avatar:       'images/ariyan-khan-profile.webp?v=2',
  rating:       '4.9',
  heroReviews:  '400+',
  orderLabel:   'Order Now',
};

class ServiceProfile extends HTMLElement {
  connectedCallback() {
    const service = this.getAttribute('service') || '';
    const portfolioCategory = this.getAttribute('portfolio-category') || service;
    const serviceLabel = this.getAttribute('service-label') || service;
    const imageSrc = this.getAttribute('image-src') || '';
    const imageAlt = this.getAttribute('image-alt') || '';
    const previewId = this.getAttribute('preview-id') || '';
    const role = this.getAttribute('editor-role') || 'Professional Video Editor';
    const basePath = this.getAttribute('base-path') || '';
    const orderHref = service ? `${basePath}index.html?service=${service}#contact` : `${basePath}index.html#contact`;
    const previewSrc = previewId
      ? `https://img.youtube.com/vi/${previewId}/maxresdefault.jpg`
      : imageSrc;

    this.outerHTML = `
      <aside class="service-profile-card" aria-label="${serviceLabel} video editing order card">
        <div class="service-profile-media" data-hero-portfolio-slider="${portfolioCategory}" data-hero-initial-src="${imageSrc}">
          <button class="service-profile-media-link" type="button" aria-label="Play ${serviceLabel.toLowerCase()} portfolio video">
            <img src="${imageSrc}" alt="${imageAlt}" class="service-profile-image is-active" width="1200" height="630" loading="eager" data-hero-slide-current>
            <img src="${previewSrc}" alt="" class="service-profile-image" width="1200" height="675" loading="eager" data-hero-slide-next aria-hidden="true">
            <div class="service-profile-play" aria-hidden="true"></div>
          </button>
          <button class="service-profile-nav service-profile-nav-prev" type="button" aria-label="Previous portfolio video" data-hero-slide-prev>&lsaquo;</button>
          <button class="service-profile-nav service-profile-nav-next" type="button" aria-label="Next portfolio video" data-hero-slide-next-btn>&rsaquo;</button>
        </div>
        <div class="service-profile-body">
          <div class="service-profile-header">
            <div class="service-profile-avatar-wrap">
              <img src="${basePath}${SITE.avatar}" alt="${SITE.name}" class="service-profile-avatar" width="64" height="64" loading="lazy">
            </div>
            <div class="service-profile-meta">
              <a class="service-profile-name" href="${basePath}about.html">${SITE.name}</a>
              <div class="service-profile-role">${role}</div>
            </div>
            <div class="service-profile-rating">
              <small>${SITE.rating} &middot; ${SITE.heroReviews} reviews</small>
              <span aria-label="5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
            </div>
          </div>
          <a class="service-profile-button" href="${orderHref}">${SITE.orderLabel} <span aria-hidden="true">&rarr;</span></a>
        </div>
      </aside>
    `;
  }
}

customElements.define('service-profile', ServiceProfile);
