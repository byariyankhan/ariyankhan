<?php
/* ══════════════════════════════════════════════════
   MCP server ("Ariyan Workspace") — tool definitions
   and dispatch logic for Ariyan's mailbox and client
   project tracker, used by Claude/ChatGPT custom
   connectors. Mail: check_new_mail, list_threads,
   get_thread, send_reply. Tracker: list_projects,
   create_project, update_project, update_project_stage.
   See the entry-point script at the site root for the
   JSON-RPC/HTTP transport.
   ══════════════════════════════════════════════════ */

require_once __DIR__ . '/inbox-db.php';
require_once __DIR__ . '/inbox-mail.php';
require_once __DIR__ . '/tracker-db.php';
require_once __DIR__ . '/tracker-mail.php';

const MCP_PROTOCOL_VERSION = '2025-06-18';

function mcp_tool_definitions(): array {
  return [
    [
      'name' => 'check_new_mail',
      'title' => 'Check New Mail',
      'description' => 'Checks the hi@ariyankhan.com inbox for new messages that have arrived since the last check, and reports how many were found. Call this first when asked to check for new mail. After this, call list_threads or get_thread to actually read what came in.',
      'inputSchema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
    ],
    [
      'name' => 'list_threads',
      'title' => 'List Conversations',
      'description' => 'Lists every email conversation in the inbox, most recently active first. Each entry shows the contact name/email, whether it has an unread message, and a preview of the latest message. Use this to see what needs attention.',
      'inputSchema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
    ],
    [
      'name' => 'get_thread',
      'title' => 'Read a Conversation',
      'description' => 'Fetches the complete message history for one email conversation, identified by the contact\'s email address. Returns every message (both received and previously sent by Ariyan) with full body text, in chronological order. Use this to read the actual content before writing a brief or a reply.',
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'contact_email' => ['type' => 'string', 'description' => 'The email address of the contact whose conversation to read.'],
        ],
        'required' => ['contact_email'],
      ],
    ],
    [
      'name' => 'send_reply',
      'title' => 'Send an Email',
      'description' => 'Sends a real email immediately from hi@ariyankhan.com to the given address. This is a live, irreversible action — the email is actually delivered the moment this is called, it is not saved as a draft. Only call this after showing the exact subject and body to the user and getting their explicit go-ahead. If the recipient has an existing conversation, the reply is automatically threaded to it.',
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'to_email' => ['type' => 'string', 'description' => 'Recipient email address.'],
          'to_name' => ['type' => 'string', 'description' => 'Recipient display name, if known. Optional — will be looked up from the existing conversation if omitted.'],
          'subject' => ['type' => 'string', 'description' => 'Email subject line.'],
          'body' => ['type' => 'string', 'description' => 'Plain-text email body.'],
        ],
        'required' => ['to_email', 'subject', 'body'],
      ],
    ],
    [
      'name' => 'list_projects',
      'title' => 'List Projects',
      'description' => 'Lists every project in the tracker, most recently created first. Shows the tracking code, project label, client name/email, current stage, delivery date, and payment status (price, advance paid, percentage). Use this to see what\'s in progress or to find a project\'s tracking code.',
      'inputSchema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
    ],
    [
      'name' => 'create_project',
      'title' => 'Create Project',
      'description' => 'Creates a new tracked project and generates a client-facing tracking code (looked up on the public track.html page). New projects always start at stage 0 (Footage Received). If client_email is given, an order-confirmation email with the tracking code and a track-my-project link is sent immediately, and future update_project_stage calls can notify the client automatically — without it, the client never gets the code and can\'t be notified later. If this project is coming from an email inquiry, always pass the contact_email/contact_name you already have from that thread; don\'t leave these blank just because the user didn\'t repeat them out loud. Always pass service_key too — it\'s what determines which service page a review from this client publishes to once the project is delivered; without it, a submitted review has nowhere specific to show. delivery_date and price_amount are also required — there is no free-text payment note anymore; the client-facing payment status line is calculated automatically from price_amount and advance_amount.',
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'project_label' => ['type' => 'string', 'description' => 'Short client-facing project name, e.g. "Documentary Edit".'],
          'client_name' => ['type' => 'string', 'description' => 'Client\'s name, if known. Optional, but include it whenever you already have it (e.g. from an inbox thread).'],
          'client_email' => ['type' => 'string', 'description' => 'Client\'s email address. Optional, but include it whenever you already have it (e.g. from an inbox thread) — without it, no confirmation email is sent and the client can\'t be notified of later stage updates.'],
          'service_key' => ['type' => 'string', 'enum' => array_keys(TRACKER_SERVICE_KEYS), 'description' => 'Which service this project is for — controls which page a review from this client shows up on once submitted: talking-head, documentary, short-form, or map-animation.'],
          'delivery_date' => ['type' => 'string', 'description' => 'Expected delivery date in YYYY-MM-DD format. Required.'],
          'price_amount' => ['type' => 'number', 'description' => 'Total project price in dollars, e.g. 300. Required.'],
          'advance_amount' => ['type' => 'number', 'description' => 'Advance/deposit already paid, in dollars. Optional, defaults to 0 — set it later with update_project once an advance actually comes in.'],
        ],
        'required' => ['project_label', 'service_key', 'delivery_date', 'price_amount'],
      ],
    ],
    [
      'name' => 'update_project',
      'title' => 'Update Project',
      'description' => 'Updates one or more fields on an existing project, identified by its tracking code. Only the fields you provide are changed — omit any you don\'t want to touch. Use this for renaming the project, correcting client info, recording a payment (set advance_amount when a deposit or final payment comes in — the client-facing status line is calculated automatically from price_amount/advance_amount, there\'s no free-text note to write), setting/changing the delivery date, or fixing the service a project is tagged to. To change the stage instead, use update_project_stage.',
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'code' => ['type' => 'string', 'description' => 'The project\'s tracking code, e.g. "7K4M-9XPQ".'],
          'project_label' => ['type' => 'string', 'description' => 'New client-facing project name.'],
          'client_name' => ['type' => 'string', 'description' => 'New client name.'],
          'client_email' => ['type' => 'string', 'description' => 'New client email address.'],
          'delivery_date' => ['type' => 'string', 'description' => 'Delivery date in YYYY-MM-DD format. Pass an empty string to clear it.'],
          'price_amount' => ['type' => 'number', 'description' => 'Total project price in dollars. Replaces the existing price.'],
          'advance_amount' => ['type' => 'number', 'description' => 'Amount paid so far, in dollars — e.g. set this when a deposit or the final payment arrives. Replaces the existing amount (not added to it).'],
          'service_key' => ['type' => 'string', 'enum' => array_keys(TRACKER_SERVICE_KEYS), 'description' => 'Which service page a review from this client should publish to: talking-head, documentary, short-form, or map-animation.'],
        ],
        'required' => ['code'],
      ],
    ],
    [
      'name' => 'update_project_stage',
      'title' => 'Update Project Stage',
      'description' => 'Changes a project\'s stage, identified by its tracking code. Stages in order: 0 Footage Received, 1 Payment (Advance), 2 Editing In Progress, 3 In Review, 4 Payment (Full), 5 Delivered. If the project has a client_email on file and notify_client is not false, the client is emailed about the change — moving to stage 5 (Delivered) sends a different email than the others: it thanks them and asks, low-pressure, whether they\'d be open to a quick testimonial, instead of the generic stage-update notice.',
      'inputSchema' => [
        'type' => 'object',
        'properties' => [
          'code' => ['type' => 'string', 'description' => 'The project\'s tracking code, e.g. "7K4M-9XPQ".'],
          'stage' => ['type' => 'integer', 'description' => 'New stage, 0-5 (see tool description for meanings).'],
          'notify_client' => ['type' => 'boolean', 'description' => 'Whether to email the client about the stage change, if they have an email on file. Defaults to true.'],
        ],
        'required' => ['code', 'stage'],
      ],
    ],
  ];
}

function mcp_text_result(string $text, bool $is_error = false): array {
  return [
    'content' => [['type' => 'text', 'text' => $text]],
    'isError' => $is_error,
  ];
}

function mcp_call_tool(string $name, array $args): array {
  $db = inbox_db();

  if ($name === 'check_new_mail') {
    $result = inbox_fetch_new();
    if ($result['error'] !== null) {
      return mcp_text_result("Could not check mail: {$result['error']}", true);
    }
    if ($result['fetched'] === 0) {
      return mcp_text_result('No new mail since the last check.');
    }

    $threads = inbox_threads($db);
    $lines = ["{$result['fetched']} new message(s) arrived. Unread conversations right now:"];
    foreach ($threads as $thread) {
      if (!$thread['unread']) {
        continue;
      }
      $msgs = $thread['messages'];
      $last = $msgs[count($msgs) - 1];
      $who = $thread['contact_name'] !== '' ? $thread['contact_name'] : $thread['contact_email'];
      $preview = mb_strimwidth((string) preg_replace('/\s+/', ' ', $last['body']), 0, 200, '…');
      $lines[] = "- {$who} <{$thread['contact_email']}> — \"{$last['subject']}\" — {$preview}";
    }
    return mcp_text_result(implode("\n", $lines));
  }

  if ($name === 'list_threads') {
    $threads = inbox_threads($db);
    if (!$threads) {
      return mcp_text_result('No conversations yet.');
    }
    $lines = [];
    foreach ($threads as $thread) {
      $msgs = $thread['messages'];
      $last = $msgs[count($msgs) - 1];
      $who = $thread['contact_name'] !== '' ? $thread['contact_name'] : $thread['contact_email'];
      $flag = $thread['unread'] ? ' [UNREAD]' : '';
      $lines[] = "- {$who} <{$thread['contact_email']}>{$flag} — last: \"{$last['subject']}\" (" . inbox_format_time((string) $last['created_at']) . ')';
    }
    return mcp_text_result(implode("\n", $lines));
  }

  if ($name === 'get_thread') {
    $contact_email = trim((string) ($args['contact_email'] ?? ''));
    if ($contact_email === '' || !filter_var($contact_email, FILTER_VALIDATE_EMAIL)) {
      return mcp_text_result('A valid contact_email is required.', true);
    }

    $threads = inbox_threads($db);
    $key = strtolower($contact_email);
    if (!isset($threads[$key])) {
      return mcp_text_result("No conversation found with {$contact_email}.", true);
    }

    inbox_mark_thread_read($db, $contact_email);
    $thread = $threads[$key];
    $who = $thread['contact_name'] !== '' ? $thread['contact_name'] : $thread['contact_email'];
    $lines = ["Conversation with {$who} <{$thread['contact_email']}>:", ''];
    foreach ($thread['messages'] as $msg) {
      $from = $msg['direction'] === 'out' ? 'Ariyan (sent)' : $who;
      $lines[] = "--- {$from} — " . inbox_format_time((string) $msg['created_at']) . " — Subject: {$msg['subject']} ---";
      $lines[] = (string) $msg['body'];
      $lines[] = '';
    }
    return mcp_text_result(implode("\n", $lines));
  }

  if ($name === 'send_reply') {
    $to_email = trim((string) ($args['to_email'] ?? ''));
    $to_name = trim((string) ($args['to_name'] ?? ''));
    $subject = trim((string) ($args['subject'] ?? ''));
    $body = trim((string) ($args['body'] ?? ''));

    if ($to_email === '' || !filter_var($to_email, FILTER_VALIDATE_EMAIL) || $subject === '' || $body === '') {
      return mcp_text_result('to_email (valid), subject, and body are all required.', true);
    }

    $threads = inbox_threads($db);
    $key = strtolower($to_email);
    $in_reply_to = '';
    if (isset($threads[$key])) {
      $msgs = $threads[$key]['messages'];
      $last = $msgs[count($msgs) - 1];
      $in_reply_to = (string) $last['message_id'];
      if ($to_name === '' && $threads[$key]['contact_name'] !== '') {
        $to_name = $threads[$key]['contact_name'];
      }
    }

    $result = inbox_send($to_email, $to_name, $subject, $body, $in_reply_to);
    if (!$result['ok']) {
      return mcp_text_result("Send failed: " . ($result['error'] ?? 'unknown error'), true);
    }
    return mcp_text_result("Email sent to {$to_email}.");
  }

  if ($name === 'list_projects') {
    $projects = tracker_db()->query('SELECT * FROM projects ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);
    if (!$projects) {
      return mcp_text_result('No projects yet.');
    }
    $lines = [];
    foreach ($projects as $p) {
      $stage_label = TRACKER_STAGES[(int) $p['stage']]['label'] ?? ('Stage ' . $p['stage']);
      $who = $p['client_name'] !== '' ? $p['client_name'] : ($p['client_email'] !== '' ? $p['client_email'] : 'no client on file');
      $label = $p['project_label'] !== '' ? $p['project_label'] : '(untitled)';
      $delivery = $p['delivery_date'] !== '' ? ", delivery {$p['delivery_date']}" : '';
      $payment_note = tracker_payment_note((float) ($p['price_amount'] ?? 0), (float) ($p['advance_amount'] ?? 0));
      $price = (float) ($p['price_amount'] ?? 0) > 0 ? ' — ' . tracker_format_money((float) $p['price_amount']) . ($payment_note !== '' ? " ({$payment_note})" : ' (no advance yet)') : '';
      $service = ($p['service_key'] ?? '') !== '' ? " — service: {$p['service_key']}" : ' — service: none set';
      $lines[] = "- {$p['code']} — \"{$label}\" — {$who} — stage: {$stage_label}{$service}{$delivery}{$price}";
    }
    return mcp_text_result(implode("\n", $lines));
  }

  if ($name === 'create_project') {
    $label = trim((string) ($args['project_label'] ?? ''));
    $client_name = trim((string) ($args['client_name'] ?? ''));
    $client_email = trim((string) ($args['client_email'] ?? ''));
    $service_key = trim((string) ($args['service_key'] ?? ''));
    $delivery_date = trim((string) ($args['delivery_date'] ?? ''));
    $price_amount = (float) ($args['price_amount'] ?? 0);
    $advance_amount = (float) ($args['advance_amount'] ?? 0);

    if ($label === '') {
      return mcp_text_result('project_label is required.', true);
    }
    if ($client_email !== '' && !filter_var($client_email, FILTER_VALIDATE_EMAIL)) {
      return mcp_text_result('client_email is not a valid email address.', true);
    }
    if (!array_key_exists($service_key, TRACKER_SERVICE_KEYS)) {
      $valid = implode(', ', array_keys(TRACKER_SERVICE_KEYS));
      return mcp_text_result("service_key must be one of: {$valid}.", true);
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $delivery_date)) {
      return mcp_text_result('delivery_date is required, in YYYY-MM-DD format.', true);
    }
    if ($price_amount <= 0) {
      return mcp_text_result('price_amount is required and must be greater than 0.', true);
    }
    if ($advance_amount < 0) {
      $advance_amount = 0;
    }

    $tdb = tracker_db();
    $now = gmdate('c');
    $code = tracker_generate_code();
    $stage_dates = json_encode(['0' => gmdate('Y-m-d')], JSON_FORCE_OBJECT);

    $stmt = $tdb->prepare(
      'INSERT INTO projects (code, project_label, stage, stage_dates, client_name, client_email, service_key, delivery_date, price_amount, advance_amount, created_at, updated_at)
       VALUES (:code, :label, 0, :stage_dates, :client_name, :client_email, :service_key, :delivery_date, :price_amount, :advance_amount, :now, :now)'
    );
    $stmt->execute([
      'code' => $code,
      'label' => $label,
      'stage_dates' => $stage_dates,
      'client_name' => $client_name,
      'client_email' => $client_email,
      'service_key' => $service_key,
      'delivery_date' => $delivery_date,
      'price_amount' => $price_amount,
      'advance_amount' => $advance_amount,
      'now' => $now,
    ]);

    $result = "Created project \"{$label}\" with tracking code {$code} (stage: Footage Received, service: {$service_key}, price: " . tracker_format_money($price_amount) . ", delivery: {$delivery_date}).";
    if ($client_email !== '') {
      $sent = tracker_send_order_email($client_email, $client_name, $label, $code);
      $result .= $sent ? " Order confirmation emailed to {$client_email}." : ' Email to the client failed to send.';
    }
    return mcp_text_result($result);
  }

  if ($name === 'update_project') {
    $code = tracker_normalize_code(trim((string) ($args['code'] ?? '')));
    if ($code === '') {
      return mcp_text_result('A valid code is required.', true);
    }

    $tdb = tracker_db();
    $stmt = $tdb->prepare('SELECT id FROM projects WHERE code = :code');
    $stmt->execute(['code' => $code]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$existing) {
      return mcp_text_result("No project found with code {$code}.", true);
    }

    $fields = [];
    $params = ['id' => $existing['id'], 'now' => gmdate('c')];

    if (array_key_exists('project_label', $args)) {
      $fields[] = 'project_label = :project_label';
      $params['project_label'] = trim((string) $args['project_label']);
    }
    if (array_key_exists('client_name', $args)) {
      $fields[] = 'client_name = :client_name';
      $params['client_name'] = trim((string) $args['client_name']);
    }
    if (array_key_exists('client_email', $args)) {
      $email = trim((string) $args['client_email']);
      if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return mcp_text_result('client_email is not a valid email address.', true);
      }
      $fields[] = 'client_email = :client_email';
      $params['client_email'] = $email;
    }
    if (array_key_exists('price_amount', $args)) {
      $price_amount = (float) $args['price_amount'];
      if ($price_amount < 0) {
        return mcp_text_result('price_amount cannot be negative.', true);
      }
      $fields[] = 'price_amount = :price_amount';
      $params['price_amount'] = $price_amount;
    }
    if (array_key_exists('advance_amount', $args)) {
      $advance_amount = (float) $args['advance_amount'];
      if ($advance_amount < 0) {
        return mcp_text_result('advance_amount cannot be negative.', true);
      }
      $fields[] = 'advance_amount = :advance_amount';
      $params['advance_amount'] = $advance_amount;
    }
    if (array_key_exists('delivery_date', $args)) {
      $date = trim((string) $args['delivery_date']);
      if ($date !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        return mcp_text_result('delivery_date must be in YYYY-MM-DD format (or an empty string to clear it).', true);
      }
      $fields[] = 'delivery_date = :delivery_date';
      $params['delivery_date'] = $date;
    }
    if (array_key_exists('service_key', $args)) {
      $service_key = trim((string) $args['service_key']);
      if (!array_key_exists($service_key, TRACKER_SERVICE_KEYS)) {
        $valid = implode(', ', array_keys(TRACKER_SERVICE_KEYS));
        return mcp_text_result("service_key must be one of: {$valid}.", true);
      }
      $fields[] = 'service_key = :service_key';
      $params['service_key'] = $service_key;
    }

    if (!$fields) {
      return mcp_text_result('Nothing to update — provide at least one of project_label, client_name, client_email, delivery_date, price_amount, advance_amount, or service_key.', true);
    }

    $fields[] = 'updated_at = :now';
    $tdb->prepare('UPDATE projects SET ' . implode(', ', $fields) . ' WHERE id = :id')->execute($params);

    return mcp_text_result("Project {$code} updated.");
  }

  if ($name === 'update_project_stage') {
    $code = tracker_normalize_code(trim((string) ($args['code'] ?? '')));
    $stage = (int) ($args['stage'] ?? -1);
    $notify_client = array_key_exists('notify_client', $args) ? (bool) $args['notify_client'] : true;

    if ($code === '' || $stage < 0 || $stage > TRACKER_MAX_STAGE) {
      return mcp_text_result('A valid code and a stage between 0 and ' . TRACKER_MAX_STAGE . ' are required.', true);
    }

    $tdb = tracker_db();
    $stmt = $tdb->prepare('SELECT * FROM projects WHERE code = :code');
    $stmt->execute(['code' => $code]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$existing) {
      return mcp_text_result("No project found with code {$code}.", true);
    }

    $previous_stage = (int) $existing['stage'];
    $stage_dates = json_decode((string) $existing['stage_dates'], true);
    if (!is_array($stage_dates)) {
      $stage_dates = [];
    }
    if (!isset($stage_dates[(string) $stage])) {
      $stage_dates[(string) $stage] = gmdate('Y-m-d');
    }

    $stmt = $tdb->prepare('UPDATE projects SET stage = :stage, stage_dates = :stage_dates, updated_at = :now WHERE id = :id');
    $stmt->execute([
      'stage' => $stage,
      'stage_dates' => json_encode($stage_dates, JSON_FORCE_OBJECT),
      'now' => gmdate('c'),
      'id' => $existing['id'],
    ]);

    $stage_label = TRACKER_STAGES[$stage]['label'] ?? "Stage {$stage}";
    $result = "Project {$code} moved to: {$stage_label}.";

    $client_email = (string) ($existing['client_email'] ?? '');
    if ($notify_client && $client_email !== '' && $stage !== $previous_stage) {
      $sent = tracker_send_stage_update_email(
        $client_email,
        (string) ($existing['client_name'] ?? ''),
        (string) ($existing['project_label'] ?? ''),
        $code,
        $stage_label
      );
      $result .= $sent ? ' Client notified by email.' : ' Client notification email failed to send.';
    }

    return mcp_text_result($result);
  }

  return mcp_text_result("Unknown tool: {$name}", true);
}
