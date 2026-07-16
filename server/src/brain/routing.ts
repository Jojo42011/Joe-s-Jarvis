const SONNET_TRIGGERS = [
  'marco', 'arthur', 'joe', 'gus', 'client',
  'remember', 'recall', 'store', 'learned', 'memory', 'graph',
  'read', 'write', 'list', 'edit', 'file',
  'build', 'deploy', 'fix', 'analyze', 'code',
  'search', 'look up', 'find', 'what is', 'price',
  'email', 'calendar', 'send', 'book', 'schedule',
  'pool', 'spa', 'project', 'crew', 'vendor', 'quote', 'invoice',
];

export function needsSonnet(message: string): boolean {
  const lower = message.toLowerCase();
  return SONNET_TRIGGERS.some((t) => lower.includes(t));
}

export function isGreeting(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return /^(hi|hey|hello|good morning|good afternoon|good evening|yo|sup)\b/.test(lower)
    && lower.length < 40;
}
