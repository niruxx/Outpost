<?php
/** Outpost billing API v1. Install this directory under WHMCS modules/servers/. */
if (!defined('WHMCS')) { die('Direct access is not allowed'); }

function outpost_MetaData() {
    return ['DisplayName' => 'Outpost', 'APIVersion' => '1.1', 'RequiresServer' => true];
}

function outpost_ConfigOptions() {
    return [
        'Outpost plan ID' => ['Type' => 'text', 'Size' => '60', 'Description' => 'Exact plan ID from Outpost Fleet → Billing'],
        'Synchronize expiry' => ['Type' => 'yesno', 'Description' => 'Optional. Uses the WHMCS next due date in UTC; otherwise WHMCS controls overdue suspension.'],
    ];
}

function outpost_request(array $params, $action) {
    $host = trim($params['serverhostname'] ?? '');
    $origin = strpos($host, '://') === false ? 'https://' . $host : $host;
    $parsed = parse_url($origin);
    if (!$parsed || ($parsed['scheme'] ?? '') !== 'https' || !empty($parsed['user']) || !empty($parsed['pass'])) {
        throw new RuntimeException('Configure the Outpost server hostname as an HTTPS origin.');
    }
    $origin = rtrim($origin, '/');
    $connection = (string)($params['serverusername'] ?? '');
    $secret = (string)($params['serverpassword'] ?? '');
    if (!$connection || !$secret) { throw new RuntimeException('Server username must be the billing connection ID; password must be its secret.'); }
    $body = ['action' => $action];
    if ($action !== 'ping') {
        $body += ['externalId' => (string)$params['serviceid'], 'customerId' => (string)$params['clientsdetails']['userid'], 'planId' => (string)$params['configoption1']];
        if (!empty($params['configoption2']) && isset($params['model']->nextduedate)) {
            $date = (string)$params['model']->nextduedate;
            if (preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/', $date) && $date !== '0000-00-00') {
                $body['expiresAt'] = (new DateTimeImmutable($date . ' 23:59:59', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
            }
        }
    }
    $raw = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    // A new module invocation is a new delivery. Transport retries below retain this ID.
    // Outpost also binds external service IDs, so a lost Create response cannot duplicate an instance.
    $delivery = bin2hex(random_bytes(16));
    $timestamp = (string)time();
    $signature = hash_hmac('sha256', $timestamp . ':' . $delivery . ':' . $raw, $secret);
    $response = false; $error = ''; $status = 0;
    for ($attempt = 0; $attempt < 2; $attempt++) {
        $curl = curl_init($origin . '/api/billing/events/' . rawurlencode($connection));
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $raw, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 90, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Outpost-Event-Id: ' . $delivery,
                'X-Outpost-Timestamp: ' . $timestamp, 'X-Outpost-Signature: ' . $signature]]);
        $response = curl_exec($curl); $error = curl_error($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
        if ($response !== false) { break; }
    }
    if ($response === false) { throw new RuntimeException('Outpost connection failed; inspect its service/event record before retrying: ' . $error); }
    $data = json_decode($response, true);
    if ($status < 200 || $status >= 300 || !is_array($data) || empty($data['ok'])) {
        throw new RuntimeException('Outpost: ' . (is_array($data) ? ($data['error'] ?? ('HTTP ' . $status)) : ('HTTP ' . $status)));
    }
    return $data;
}

function outpost_action(array $params, $action) {
    try { outpost_request($params, $action); return 'success'; }
    catch (Throwable $error) { return $error->getMessage(); }
}
function outpost_CreateAccount(array $params) { return outpost_action($params, 'create'); }
function outpost_SuspendAccount(array $params) { return outpost_action($params, 'suspend'); }
function outpost_UnsuspendAccount(array $params) { return outpost_action($params, 'unsuspend'); }
function outpost_TerminateAccount(array $params) { return outpost_action($params, 'terminate'); }
function outpost_Renew(array $params) { return outpost_action($params, 'renew'); }
function outpost_ChangePackage(array $params) { return outpost_action($params, 'changePlan'); }
function outpost_TestConnection(array $params) {
    try { outpost_request($params, 'ping'); return ['success' => true]; }
    catch (Throwable $error) { return ['success' => false, 'error' => $error->getMessage()]; }
}
