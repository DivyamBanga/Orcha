// The system prompt a chat starts with. It's built once, when the chat's
// first message is sent, and stored with the chat: a prompt that changed
// between turns would throw away the prompt cache (and, on the newest Claude
// models, the reasoning bound to it), so later changes to settings apply to
// new chats.

export function buildSystemPrompt(opts: { now: Date }): string {
  const date = opts.now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  return [
    "You're chatting with someone in Orcha, a desktop app for working with AI. Be direct and genuinely helpful.",
    'Write in Markdown. Match the length to the question: a casual message gets a short, natural reply; use headings, lists and tables only when they make an answer easier to read. Put code in fenced blocks with the language named.',
    `Today is ${date}.`
  ].join('\n\n')
}
