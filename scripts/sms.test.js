/**
 * Carrier-compliance pin for outbound SMS (run via `npm test`, which builds
 * first and asserts against the compiled module).
 *
 * These assertions exist so a future edit cannot silently drop language the
 * A2P 10DLC registration requires us to send, or reintroduce a From number
 * that would bypass the carrier-registered sender pool.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest_compliance';

const { applyCarrierTemplate, twilioCreateParams } = require('../server/dist/services/sms');

test('every outbound text carries the carrier-approved template', () => {
  const out = applyCarrierTemplate('New lead from the phone line: Dan, (330) 555-0142.');
  assert.ok(out.startsWith('Totally Outdoors: '), 'missing "Totally Outdoors:" prefix');
  assert.ok(out.endsWith('Reply STOP to cancel, HELP for help.'), 'missing STOP/HELP line');
  assert.ok(out.includes('New lead from the phone line: Dan'), 'message body was lost');
});

test('template wrapping is idempotent — a retry cannot double-wrap', () => {
  const once = applyCarrierTemplate('Invoice TO-2026-14 paid.');
  const twice = applyCarrierTemplate(once);
  assert.equal(twice, once);
  assert.equal(twice.match(/Totally Outdoors: /g).length, 1);
  assert.equal(twice.match(/Reply STOP to cancel, HELP for help\./g).length, 1);
});

test('wire request includes MessagingServiceSid and does NOT include From', () => {
  const params = twilioCreateParams('+13305550100', 'body text');
  assert.equal(params.messagingServiceSid, 'MGtest_compliance');
  assert.equal(params.to, '+13305550100');
  assert.equal(params.body, 'body text');
  assert.ok(!('from' in params), 'From must never be set — it bypasses the A2P registration');
  assert.ok(!('From' in params), 'From must never be set — it bypasses the A2P registration');
});
