export const IDENTITY_DIMENSIONS = [
  'DECISIONS', 'VALUES', 'FEARS', 'MOTIVATION', 'EMOTIONS', 'RELATIONSHIPS',
  'MONEY', 'IDENTITY', 'VISION', 'CONFLICT', 'LEARNING', 'ENERGY',
] as const;

export type IdentityDimension = (typeof IDENTITY_DIMENSIONS)[number];

export const CURIOSITY_QUESTIONS: Record<IdentityDimension, string[]> = {
  DECISIONS: [
    'When you make a call on a big job, sir — gut or spreadsheet first?',
    'What makes a decision feel right to you before you commit?',
    'Do you prefer reversible bets or do you commit fully once decided?',
    'What is the fastest decision you have regretted — and why?',
    'When two options look equal, what breaks the tie for you?',
  ],
  VALUES: [
    'What would you never compromise on, even for a lucrative client?',
    'Where do you draw the line between flexibility and principle?',
    'What do you stand for that your competitors do not?',
    'What value do you protect even when it costs margin?',
    'What would make you walk away from a signed contract?',
  ],
  FEARS: [
    'What does failure look like for you personally — not just the business?',
    'What keeps you up at night that you rarely say aloud?',
    'What risk do you avoid thinking about until you have to?',
    'What would a bad month feel like beyond the numbers?',
    'What mistake are you most determined never to repeat?',
  ],
  MOTIVATION: [
    'Why are you building this — beyond revenue?',
    'Who are you building for when the day gets long?',
    'What would make this feel genuinely worth it in five years?',
    'What outcome would make you proud regardless of profit?',
    'What fuels you when motivation is thin?',
  ],
  EMOTIONS: [
    'What does stress look like on you — before anyone notices?',
    'What genuinely makes you angry in this business?',
    'How do you reset after a brutal day on site?',
    'What emotion do you mask most often with clients?',
    'When do you feel most in control?',
  ],
  RELATIONSHIPS: [
    'How do you decide who earns your trust on a crew?',
    'What breaks trust for you — permanently?',
    'How does friendship change how you handle business friction?',
    'Who do you rely on that the business could not run without?',
    'How direct are you when someone disappoints you?',
  ],
  MONEY: [
    'How do you think about pricing beyond covering costs?',
    'What changes in your decisions at 10x revenue?',
    'Where are you generous when others would not be?',
    'What purchase feels justified instantly versus debated for weeks?',
    'How do you balance cash flow against growth bets?',
  ],
  IDENTITY: [
    'How do you see yourself when you are not in the room?',
    'What are you still figuring out about who you are as an owner?',
    'What title do you reject even if it fits?',
    'What do you want people to say about how you run things?',
    'What part of your identity is most tied to this company?',
  ],
  VISION: [
    'What does success look like in three years — specifically?',
    'What would you keep even at 10x scale?',
    'What would make you walk away from everything you built?',
    'What does Totally Outdoors LLC become if everything goes right?',
    'What legacy matters more than the balance sheet?',
  ],
  CONFLICT: [
    'Do you address friction early or let it resolve itself?',
    'What was the hardest conversation you had recently?',
    'How do you handle a client who pushes past your boundaries?',
    'When do you escalate versus absorb?',
    'What conflict pattern do you see repeating in your business?',
  ],
  LEARNING: [
    'What changed your mind recently — something you used to believe?',
    'What do you know you need to learn but keep avoiding?',
    'How do you grow — books, people, mistakes, or all three?',
    'Who challenges your thinking effectively?',
    'What skill would change the business most if you mastered it tomorrow?',
  ],
  ENERGY: [
    'When are your peak hours — when should I protect your time?',
    'What drains you fastest in a typical week?',
    'What does a genuinely good day feel like?',
    'How do you recover when you are running on empty?',
    'What work gives you energy instead of taking it?',
  ],
};
