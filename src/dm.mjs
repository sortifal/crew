import { config, workerByName, workerSettings } from './config.mjs';
import { allTasks, pushFeed, getFeed } from './store.mjs';
import { lessonsFor } from './lessons.mjs';

const feedName = (w) => `dm-${w.toLowerCase()}`;

function system(w) {
  const mine = allTasks().filter((t) => t.assignee === w.name).slice(-6);
  const tasks = mine.map((t) => {
    const rep = t.attempts.at(-1)?.report;
    return `- #${t.id} "${t.title}" [${t.status}]${t.question ? ` (your question: ${t.question})` : ''}${rep ? ` — your last report: ${rep.slice(0, 300)}` : ''}`;
  }).join('\n') || '(nothing yet)';
  const lessons = lessonsFor(w.name);
  return `You are ${w.name}, ${w.role} on the project "${config.project.name}". ${w.persona}${w.instructions ? `\nYour standing instructions: ${w.instructions}` : ''}
You are chatting with the project owner, like a colleague on a team chat. Reply naturally in 1–4 sentences, in first person, in character. Do not use markdown headings.
Be honest: only describe work that appears below. If you do not know, say so. You cannot change code in this chat; for changes, the owner or the Head creates a task.
Your recent tasks:
${tasks}
${lessons ? `\nThings you have learned (you remember them and may mention them):\n${lessons}` : ''}`;
}

export async function dm(name, text) {
  const w = workerByName(name);
  if (!w) throw new Error(`unknown worker "${name}"`);
  pushFeed(feedName(w.name), { role: 'user', text }, 'dm');
  const history = getFeed(feedName(w.name), 20).filter((m) => m.role !== 'error').map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const q = workerSettings(w);
  try {
    const res = await fetch(`${q.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${q.apiKey || 'local'}` },
      body: JSON.stringify({ model: q.model, temperature: 0.7, max_tokens: 400, messages: [{ role: 'system', content: system(w) }, ...history] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const reply = (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(no answer)';
    pushFeed(feedName(w.name), { role: w.name, text: reply }, 'dm');
  } catch (e) {
    pushFeed(feedName(w.name), { role: 'error', text: `Can't reach the local model: ${e.message}` }, 'dm');
  }
}
export const dmFeed = feedName;
