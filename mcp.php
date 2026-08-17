<?php
/* ══════════════════════════════════════════════════
   MCP endpoint — Streamable HTTP transport (spec
   2025-06-18). Access requires ?token=... matching
   'mcp_token' in mail-config.local.php (gitignored,
   server-only — same pattern as every other secret
   in this project). Tool logic lives in
   lib/mcp-server.php.
   ══════════════════════════════════════════════════ */

require_once __DIR__ . '/lib/mcp-server.php';

header('Content-Type: application/json');

function mcp_auth_token(): ?string {
  $local_path = __DIR__ . '/mail-config.local.php';
  if (!is_file($local_path)) {
    return null;
  }
  $config = require $local_path;
  return is_array($config) ? ($config['mcp_token'] ?? null) : null;
}

$expected_token = mcp_auth_token();
$provided_token = (string) ($_GET['token'] ?? '');

if ($expected_token === null || $provided_token === '' || !hash_equals($expected_token, $provided_token)) {
  http_response_code(401);
  echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32001, 'message' => 'Unauthorized']]);
  exit;
}

$http_method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// No SSE stream offered — GET (listen) and DELETE (session teardown) are
// both spec-legal to decline outright.
if ($http_method === 'GET' || $http_method === 'DELETE') {
  http_response_code(405);
  header('Allow: POST');
  exit;
}

if ($http_method !== 'POST') {
  http_response_code(405);
  exit;
}

$raw = file_get_contents('php://input');
$request = json_decode($raw, true);

if (!is_array($request) || !isset($request['jsonrpc']) || $request['jsonrpc'] !== '2.0') {
  http_response_code(400);
  echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => 'Invalid Request']]);
  exit;
}

$id = $request['id'] ?? null;
$rpc_method = (string) ($request['method'] ?? '');
$params = is_array($request['params'] ?? null) ? $request['params'] : [];

// A message with no id is a notification (e.g. notifications/initialized) —
// accept silently per spec, no JSON-RPC response body.
if ($id === null) {
  http_response_code(202);
  exit;
}

function mcp_respond(mixed $id, array $result): never {
  echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]);
  exit;
}

function mcp_respond_error(mixed $id, int $code, string $message): never {
  echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]]);
  exit;
}

if ($rpc_method === 'initialize') {
  mcp_respond($id, [
    'protocolVersion' => MCP_PROTOCOL_VERSION,
    'capabilities' => ['tools' => ['listChanged' => false]],
    'serverInfo' => [
      'name' => 'ariyan-workspace',
      'title' => 'Ariyan Workspace',
      'version' => '1.0.0',
    ],
    'instructions' => "Tools for Ariyan Khan's business inbox (hi@ariyankhan.com) and client project tracker.\n\n"
      . "MAIL: check_new_mail first to see what just arrived, list_threads for an overview, get_thread to read a full conversation, send_reply to reply. Always take the contact's address from list_threads/get_thread's contact_email field — never guess it or parse it out of a message body; the inbox already resolves each visitor to their real address.\n\n"
      . "TRACKER: list_projects to see what's in progress, create_project to start tracking a new job, update_project to edit its name/client info/payment note/delivery date, update_project_stage to move it forward. All project tools take the tracking code (e.g. \"7K4M-9XPQ\"), never a numeric ID. Before creating a project, check list_projects first — if one already exists for this inquiry/client, update it instead of creating a duplicate. Stages: 0 Footage Received, 1 Payment (Advance), 2 Editing In Progress, 3 In Review, 4 Payment (Full), 5 Delivered — moving forward is normal, moving backward should be confirmed with the user first since it's unusual. delivery_date must be YYYY-MM-DD.\n\n"
      . "GUARDRAILS: send_reply, create_project (with a client_email), and update_project_stage (with notify_client) all take real, irreversible action — a live email actually sends. Always show the user the exact recipient and the exact subject/body or stage change, and wait for their explicit go-ahead before calling them. Never fabricate inbox or project data or assume a tool call succeeded — if a call fails, returns empty, or a thread/project isn't found, say so plainly instead of guessing or making something up.",
  ]);
}

if ($rpc_method === 'tools/list') {
  mcp_respond($id, ['tools' => mcp_tool_definitions()]);
}

if ($rpc_method === 'tools/call') {
  $tool_name = (string) ($params['name'] ?? '');
  $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
  mcp_respond($id, mcp_call_tool($tool_name, $args));
}

if ($rpc_method === 'ping') {
  mcp_respond($id, []);
}

mcp_respond_error($id, -32601, "Method not found: {$rpc_method}");
