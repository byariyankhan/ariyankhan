<?php
/* ══════════════════════════════════════════════════
   Shared admin project-card markup — used by both
   dashboard/index.php (all projects) and dashboard/orders.php
   (Delivered only) so the two never drift apart.
   All forms post to index.php, whichever page they're
   rendered from, since that's where the action handling
   lives; index.php honors redirect_to to send the admin
   back to the page they were actually on.
   ══════════════════════════════════════════════════ */

function tracker_render_project_card(array $project, string $redirect_to = 'index.php'): void {
  $redirectAttr = e($redirect_to);
  ?>
  <div class="tracker-project-card">
    <div class="tracker-project-head">
      <div>
        <span class="tracker-code"><?= e($project['code']) ?></span>
        <?php $svcKey = (string) ($project['service_key'] ?? ''); ?>
        <?php if ($svcKey !== '' && isset(TRACKER_SERVICE_KEYS[$svcKey])): ?>
          <span class="tracker-service-badge"><?= e(TRACKER_SERVICE_KEYS[$svcKey]) ?></span>
        <?php elseif ($svcKey === ''): ?>
          <span class="tracker-service-badge tracker-service-badge--none">No service set</span>
        <?php endif; ?>
        <h3 class="tracker-project-title"><?= e($project['project_label'] !== '' ? $project['project_label'] : '(untitled)') ?></h3>
        <?php if (($project['client_name'] ?? '') !== '' || ($project['client_email'] ?? '') !== ''): ?>
          <p class="tracker-project-client">
            <?= e((string) ($project['client_name'] ?? '')) ?>
            <?php if (($project['client_email'] ?? '') !== ''): ?>
              <?= (($project['client_name'] ?? '') !== '') ? ' · ' : '' ?><?= e((string) $project['client_email']) ?>
            <?php endif; ?>
          </p>
        <?php endif; ?>
      </div>
      <form method="post" action="index.php" onsubmit="return confirm('Delete this project?');">
        <input type="hidden" name="action" value="delete">
        <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
        <input type="hidden" name="redirect_to" value="<?= $redirectAttr ?>">
        <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Delete</button>
      </form>
    </div>

    <div class="tracker-project-fields">
      <div class="tracker-project-field">
        <label>Stage</label>
        <form method="post" action="index.php" class="tracker-stage-form">
          <input type="hidden" name="action" value="update_stage">
          <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
          <input type="hidden" name="redirect_to" value="<?= $redirectAttr ?>">
          <select name="stage" onchange="this.form.submit()">
            <?php foreach (TRACKER_STAGES as $index => $info): ?>
              <?php $stageNote = tracker_stage_payment_note($index, (float) ($project['price_amount'] ?? 0), (float) ($project['advance_amount'] ?? 0)); ?>
              <option value="<?= $index ?>" <?= ((int) $project['stage'] === $index) ? 'selected' : '' ?>>
                <?= e($info['label']) ?><?= $stageNote !== '' ? ' — ' . e($stageNote) : '' ?>
              </option>
            <?php endforeach; ?>
          </select>
          <?php if (($project['client_email'] ?? '') !== ''): ?>
            <label class="tracker-notify-check">
              <input type="checkbox" name="notify_client" value="1" checked>
              Notify client by email
            </label>
          <?php endif; ?>
        </form>
      </div>

      <div class="tracker-project-field">
        <label>Delivery date</label>
        <form method="post" action="index.php" class="tracker-date-form">
          <input type="hidden" name="action" value="update_delivery">
          <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
          <input type="hidden" name="redirect_to" value="<?= $redirectAttr ?>">
          <input type="text" name="delivery_date" class="tracker-date-input" placeholder="DD/MM/YYYY" inputmode="numeric" autocomplete="off" maxlength="10" pattern="\d{2}/\d{2}/\d{4}" title="DD/MM/YYYY" value="<?= e(tracker_date_to_display((string) ($project['delivery_date'] ?? ''))) ?>">
          <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Save</button>
        </form>
      </div>

      <div class="tracker-project-field tracker-project-field--wide">
        <label>Payment</label>
        <form method="post" action="index.php" class="tracker-payment-form">
          <input type="hidden" name="action" value="update_payment">
          <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
          <input type="hidden" name="redirect_to" value="<?= $redirectAttr ?>">
          <span class="tracker-payment-input">
            <span class="tracker-payment-prefix">Price $</span>
            <input type="number" name="price_amount" min="0" step="0.01" value="<?= e((string) ($project['price_amount'] ?? '0')) ?>">
          </span>
          <span class="tracker-payment-input">
            <span class="tracker-payment-prefix">Advance $</span>
            <input type="number" name="advance_amount" min="0" step="0.01" value="<?= e((string) ($project['advance_amount'] ?? '0')) ?>">
          </span>
          <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Save Payment</button>
        </form>
      </div>

      <div class="tracker-project-field tracker-project-field--wide">
        <label>Delivery link</label>
        <form method="post" action="index.php" class="tracker-date-form">
          <input type="hidden" name="action" value="update_delivery_link">
          <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
          <input type="hidden" name="redirect_to" value="<?= $redirectAttr ?>">
          <input type="url" name="delivery_link" class="tracker-url-input" placeholder="https://drive.google.com/..." autocomplete="off" value="<?= e((string) ($project['delivery_link'] ?? '')) ?>">
          <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Save</button>
        </form>
        <p class="tracker-muted" style="margin-top:8px; font-size:12px;">
          Sent to the client automatically when the stage is moved to Delivered (with notify checked).
        </p>
      </div>
    </div>

    <p class="tracker-project-foot">Created <?= e(substr((string) $project['created_at'], 0, 10)) ?></p>
  </div>
  <?php
}
