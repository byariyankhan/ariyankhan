<?php
/* ══════════════════════════════════════════════════
   MCP server — tool definitions and dispatch logic
   for Ariyan's mailbox, used by Claude/ChatGPT custom
   connectors. Exposes: check_new_mail, list_threads,
   get_thread, send_reply. See the entry-point script
   at the site root for the JSON-RPC/HTTP transport.
   ══════════════════════════════════════════════════ */

require_once __DIR__ . '/inbox-db.php';
require_once __DIR__ . '/inbox-mail.php';

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

  return mcp_text_result("Unknown tool: {$name}", true);
}
